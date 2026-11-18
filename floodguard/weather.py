import json
import math
import os
from datetime import timedelta, timezone
from urllib.parse import unquote, urlencode
from urllib.request import urlopen

from .model import now

BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0"
KST = timezone(timedelta(hours=9))


def fetch_weather():
    key = os.getenv("KMA_SERVICE_KEY")
    if not key:
        return {"source": "simulated", "rn1_mm": 48, "forecast": [], "at": now().isoformat()}
    key = unquote(key)
    nx, ny = os.environ["KMA_NX"], os.environ["KMA_NY"]
    local = now().astimezone(KST)

    def items(endpoint, base):
        query = urlencode({
            "serviceKey": key, "nx": int(nx), "ny": int(ny), "dataType": "JSON",
            "base_date": base.strftime("%Y%m%d"), "base_time": base.strftime("%H%M"),
            "numOfRows": 100, "pageNo": 1,
        })
        with urlopen(f"{BASE}/{endpoint}?{query}", timeout=8) as response:
            data = json.load(response)["response"]
        return data["body"]["items"]["item"]

    observed = (local - timedelta(minutes=40)).replace(minute=0, second=0, microsecond=0)
    rn1 = next(float(item["obsrValue"]) for item in items("getUltraSrtNcst", observed)
               if item["category"] == "RN1")
    if not math.isfinite(rn1) or rn1 < 0:
        raise ValueError("Invalid RN1")
    forecast_base = (local - timedelta(minutes=45)).replace(minute=30, second=0, microsecond=0)
    forecast = [
        {"date": item["fcstDate"], "time": item["fcstTime"], "rain": item["fcstValue"]}
        for item in items("getUltraSrtFcst", forecast_base) if item["category"] == "RN1"
    ]
    return {"source": "kma", "rn1_mm": rn1, "forecast": forecast, "at": observed.isoformat()}
