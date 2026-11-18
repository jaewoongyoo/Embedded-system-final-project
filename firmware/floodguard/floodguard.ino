#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <time.h>
#include "config.h"

constexpr char WATER_TOPIC[] = "floodguard/store01/water";
constexpr char ALERT_TOPIC[] = "floodguard/store01/alert";
constexpr uint32_t SAMPLE_MS = 4000;
constexpr uint32_t RETRY_MS = 5000;
constexpr uint32_t COMMAND_TTL_MS = 15000;

struct Sample {
  int height;  // -1 means dry.
  int intervalSeconds;
};

Sample readSensors() {
  // Replace this function with the real debounced GPIO reader when sensors arrive.
  static const Sample script[] = {{-1, 1}, {0, 1}, {2, 200}, {6, 30}, {8, 30}, {-1, 60}};
  static size_t index = 0;
  const size_t count = sizeof(script) / sizeof(script[0]);
  const Sample sample = script[index];
  index = (index + 1) % count;
  return sample;
}

WiFiClient network;
PubSubClient mqtt(network);
int criticalHeight = 8;
float warningMinutes = 15;
int previousHeight = -1;
bool localAlarm = false;
bool remoteAlarm = false;
uint32_t lastCommand = 0;
uint32_t lastSample = 0;
uint32_t lastConnect = 0;

void receiveAlert(char* topic, byte* payload, unsigned int length) {
  JsonDocument alert;
  if (deserializeJson(alert, payload, length)) return;
  const char* level = alert["level"] | "";
  const int critical = alert["critical_cm"] | 8;
  const float warning = alert["warning_min"] | 15.0f;
  if (critical >= 2 && critical <= 8 && critical % 2 == 0) criticalHeight = critical;
  if (warning >= 5 && warning <= 120) warningMinutes = warning;
  remoteAlarm = strcmp(level, "warning") == 0 || strcmp(level, "emergency") == 0;
  lastCommand = millis();
}

void publishReading(Sample reading) {
  if (!mqtt.connected()) return;
  const time_t timestamp = time(nullptr);
  if (timestamp < 1700000000) return;  // Wait for SNTP before publishing timestamps.
  struct tm utc;
  gmtime_r(&timestamp, &utc);
  char at[24];
  strftime(at, sizeof(at), "%Y-%m-%dT%H:%M:%SZ", &utc);
  JsonDocument message;
  message["at"] = at;
  if (reading.height < 0) message["level_cm"] = nullptr;
  else message["level_cm"] = reading.height;
  message["floor_wet"] = reading.height >= 0;
  message["quality"] = "simulated";
  message["sample_interval_s"] = reading.intervalSeconds;
  char buffer[256];
  serializeJson(message, buffer, sizeof(buffer));
  mqtt.publish(WATER_TOPIC, buffer);
}

void updateSample() {
  const Sample reading = readSensors();
  const int height = reading.height;
  const int crossed = height >= 0 && height > previousHeight
    ? (previousHeight < 0 ? height / 2 + 1 : (height - previousHeight) / 2)
    : 0;
  localAlarm = height >= criticalHeight || crossed > 1;
  if (crossed == 1 && previousHeight >= 0 && !localAlarm) {
    const float rate = (height - previousHeight) * 60.0f / reading.intervalSeconds;
    localAlarm = (criticalHeight - height) / rate <= warningMinutes;
  }
  previousHeight = height;
  Serial.printf("level=%d local_alarm=%d\n", height, localAlarm);
  digitalWrite(LED_PIN, localAlarm);
  digitalWrite(BUZZER_PIN, localAlarm);
  publishReading(reading);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(receiveAlert);
  mqtt.setBufferSize(768);
  mqtt.setSocketTimeout(1);
  lastSample = millis() - SAMPLE_MS;
  lastConnect = millis() - RETRY_MS;
}

void loop() {
  const uint32_t tick = millis();
  if (tick - lastSample >= SAMPLE_MS) {
    lastSample = tick;
    updateSample();
  }
  if (WiFi.status() == WL_CONNECTED && !mqtt.connected() && tick - lastConnect >= RETRY_MS) {
    lastConnect = tick;
    char id[32];
    snprintf(id, sizeof(id), "floodguard-%llx", (unsigned long long) ESP.getEfuseMac());
    if (mqtt.connect(id)) mqtt.subscribe(ALERT_TOPIC, 1);
  }
  mqtt.loop();
  const bool alarm = localAlarm || (mqtt.connected() && remoteAlarm && millis() - lastCommand < COMMAND_TTL_MS);
  digitalWrite(LED_PIN, alarm);
  digitalWrite(BUZZER_PIN, alarm);
  delay(10);
}
