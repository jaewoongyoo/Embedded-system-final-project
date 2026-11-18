import argparse
import json
import os
from threading import Event

import paho.mqtt.client as mqtt

from .model import TOPIC, Reading, Settings, evaluate, now

# (detected height, simulated seconds since previous observation)
SCRIPT = [(None, 1), (0, 1), (2, 200), (6, 30), (8, 30), (None, 60)]


def run(loop=False, delay=4):
    connected = Event()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="floodguard-demo-device")
    settings = Settings()

    @client.connect_callback()
    def on_connect(mqtt_client, userdata, flags, reason_code, properties):
        if not reason_code.is_failure:
            mqtt_client.subscribe(f"{TOPIC}/alert", qos=1)
            connected.set()

    @client.disconnect_callback()
    def on_disconnect(mqtt_client, userdata, flags, reason_code, properties):
        connected.clear()

    @client.message_callback()
    def on_alert(mqtt_client, userdata, message):
        nonlocal settings
        try:
            alert = json.loads(message.payload)
            settings = Settings(critical_cm=alert["critical_cm"], warning_min=alert["warning_min"])
            stage, message_text = alert["level"], alert["message"]
        except (ValueError, KeyError, TypeError):
            return
        print("서버 MQTT 경보:", stage, message_text, flush=True)

    client.connect_async(os.getenv("MQTT_HOST", "127.0.0.1"), int(os.getenv("MQTT_PORT", 1883)))
    client.loop_start()
    stop = Event()
    previous = None
    try:
        connected.wait(timeout=15)
        while True:
            for height, interval in SCRIPT:
                current = Reading(at=now(), level_cm=height, floor_wet=height is not None,
                                  quality="simulated", sample_interval_s=interval)
                local = evaluate(current, previous, settings)
                buzzer = local["level"] in {"warning", "emergency"}
                print(f"센서={height}cm, 현장 부저={'ON' if buzzer else 'OFF'}", flush=True)
                if connected.is_set():
                    client.publish(f"{TOPIC}/water", current.model_dump_json(), qos=1)
                previous = current
                stop.wait(delay)
            if not loop:
                break
    except KeyboardInterrupt:
        pass
    finally:
        client.disconnect()
        client.loop_stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--delay", type=float, default=4)
    args = parser.parse_args()
    if not 0 < args.delay <= 10:
        parser.error("--delay must be greater than 0 and at most 10 seconds")
    run(args.loop, args.delay)
