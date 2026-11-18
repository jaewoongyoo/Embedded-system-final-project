import asyncio
import json
import logging
import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import paho.mqtt.client as mqtt
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .model import STORE, TOPIC, Reading, Settings, evaluate, now
from .weather import fetch_weather

ROOT = Path(__file__).resolve().parents[1]
DB = Path(os.getenv("FLOODGUARD_DB", ROOT / "data" / "floodguard.sqlite3"))
LOG = logging.getLogger(__name__)
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="floodguard-server")


@contextmanager
def database(write=False):
    connection = sqlite3.connect(DB)
    try:
        with connection:
            connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield connection
    finally:
        connection.close()


def latest(db, table, limit=1):
    # Table names come from the server's fixed schema.
    rows = db.execute(f"SELECT payload FROM {table} ORDER BY id DESC LIMIT ?", (limit,))
    return [json.loads(row[0]) for row in rows]


def settings(db):
    return Settings.model_validate((latest(db, "settings") or [{}])[0])


def weather(db):
    data = (latest(db, "weather") or [{}])[0]
    return {"rn1_mm": None, "forecast": [], "at": None, **data,
            "status": (latest(db, "weather_status") or [{"status": "waiting"}])[0]["status"]}


def snapshot(db):
    rows = latest(db, "readings", 2)
    if not rows:
        return None
    current = Reading.model_validate(rows[0])
    previous = Reading.model_validate(rows[1]) if len(rows) == 2 else None
    config, rainfall = settings(db), weather(db)
    rain_mm = rainfall["rn1_mm"] if rainfall["status"] == "ok" else None
    alert = evaluate(current, previous, config, rain_mm)
    return {**rows[0], **alert, "settings": config.model_dump()}


def update_alert(db, status):
    if status is None:
        return
    prior = latest(db, "alerts")
    if not prior or (prior[0]["level"], prior[0]["message"]) != (status["level"], status["message"]):
        alert = {key: status[key] for key in ("level", "message", "eta_min")}
        alert["at"] = now().isoformat()
        db.execute("INSERT INTO alerts(payload) VALUES (?)", (json.dumps(alert),))


def publish_alert(status):
    if status is None or (now() - Reading.model_validate(status).at).total_seconds() > 15:
        return
    alert = {key: status[key] for key in ("level", "message", "eta_min")}
    alert["critical_cm"] = status["settings"]["critical_cm"]
    alert["warning_min"] = status["settings"]["warning_min"]
    client.publish(f"{TOPIC}/alert", json.dumps(alert, ensure_ascii=False), qos=1)


@client.connect_callback()
def on_connect(mqtt_client, userdata, flags, reason_code, properties):
    if not reason_code.is_failure:
        mqtt_client.subscribe(f"{TOPIC}/water", qos=1)


@client.message_callback()
def on_message(mqtt_client, userdata, message):
    try:
        reading = Reading.model_validate_json(message.payload)
        with database(write=True) as db:
            prior = latest(db, "readings")
            if prior and reading.at <= Reading.model_validate(prior[0]).at:
                return
            data = {**reading.model_dump(mode="json"), "received_at": now().isoformat()}
            db.execute("INSERT INTO readings(payload) VALUES (?)", (json.dumps(data),))
            status = snapshot(db)
            update_alert(db, status)
        publish_alert(status)
    except (ValidationError, sqlite3.Error):
        LOG.warning("Could not store MQTT reading", exc_info=True)


def refresh_weather():
    data = None
    try:
        data = fetch_weather()
    except (OSError, ValueError, KeyError, StopIteration, TypeError):
        LOG.warning("Weather request failed; keeping last observation")
    with database(write=True) as db:
        if data:
            db.execute("INSERT INTO weather(payload) VALUES (?)", (json.dumps(data),))
        db.execute("DELETE FROM weather_status")
        db.execute("INSERT INTO weather_status(payload) VALUES (?)",
                   (json.dumps({"status": "ok" if data else "error"}),))
        status = snapshot(db)
        if status and (now() - Reading.model_validate(status).at).total_seconds() <= 15:
            update_alert(db, status)


async def weather_worker():
    while True:
        await asyncio.to_thread(refresh_weather)
        await asyncio.sleep(300)


@asynccontextmanager
async def lifespan(app):
    DB.parent.mkdir(parents=True, exist_ok=True)
    with database(write=True) as db:
        for table in ("readings", "weather", "weather_status", "alerts", "settings"):
            db.execute(f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
    client.connect_async(os.getenv("MQTT_HOST", "127.0.0.1"), int(os.getenv("MQTT_PORT", "1883")))
    client.loop_start()
    task = asyncio.create_task(weather_worker())
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        client.disconnect()
        client.loop_stop()


app = FastAPI(title="FLOOD GUARD", lifespan=lifespan)
app.mount("/dashboard", StaticFiles(directory=ROOT / "dashboard"), name="dashboard")


@app.get("/", include_in_schema=False)
def home():
    return FileResponse(ROOT / "dashboard" / "index.html")


@app.get("/style.css", include_in_schema=False)
def style():
    return FileResponse(ROOT / "simulator" / "style.css", media_type="text/css")


def require_store(store_id):
    if store_id != STORE:
        raise HTTPException(404, "Store not found")


@app.get("/api/stores/{store_id}/status")
def get_status(store_id: str):
    require_store(store_id)
    with database() as db:
        status = snapshot(db)
        config = settings(db)
    if status is None:
        return {"connection": "waiting", "broker_connected": client.is_connected(), "settings": config}
    age = (now() - Reading.model_validate(status).at).total_seconds()
    status["broker_connected"] = client.is_connected()
    status["connection"] = "online" if age <= 15 and status["broker_connected"] else "stale"
    if status["connection"] == "stale":
        status.update(rate_cm_min=None, eta_min=None)
    return status


@app.get("/api/stores/{store_id}/history")
def get_history(store_id: str):
    require_store(store_id)
    with database() as db:
        return latest(db, "readings", 60)


@app.get("/api/stores/{store_id}/alerts")
def get_alerts(store_id: str):
    require_store(store_id)
    with database() as db:
        return latest(db, "alerts", 40)


@app.get("/api/stores/{store_id}/weather")
def get_weather(store_id: str):
    require_store(store_id)
    with database() as db:
        return weather(db)


@app.patch("/api/stores/{store_id}/settings")
def patch_settings(store_id: str, patch: Settings):
    require_store(store_id)
    with database(write=True) as db:
        config = Settings.model_validate({**settings(db).model_dump(), **patch.model_dump(exclude_unset=True)})
        db.execute("DELETE FROM settings")
        db.execute("INSERT INTO settings(payload) VALUES (?)", (config.model_dump_json(),))
        status = snapshot(db)
        if status and (now() - Reading.model_validate(status).at).total_seconds() <= 15:
            update_alert(db, status)
    publish_alert(status)
    return config
