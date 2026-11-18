from datetime import datetime, timezone
from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field, model_validator

STORE = "store01"
TOPIC = f"floodguard/{STORE}"
HEIGHTS = (0, 2, 4, 6, 8)


def now():
    return datetime.now(timezone.utc)


class Reading(BaseModel):
    at: AwareDatetime
    level_cm: Literal[0, 2, 4, 6, 8] | None
    floor_wet: bool
    quality: Literal["step", "simulated"] = "step"
    sample_interval_s: float | None = Field(default=None, gt=0, le=3600)

    @model_validator(mode="after")
    def validate_contact(self):
        if not self.floor_wet and self.level_cm is not None:
            raise ValueError("A detected level requires floor contact")
        return self

    @property
    def height(self):
        return (self.level_cm or 0) if self.floor_wet else -1


class Settings(BaseModel):
    name: str = Field(default="매장 01", min_length=1, max_length=80)
    critical_cm: Literal[2, 4, 6, 8] = 8
    warning_min: float = Field(default=15, ge=5, le=120)


def evaluate(current: Reading, previous: Reading | None, settings: Settings, rain_mm=None):
    height = current.height
    rate = eta = None
    rapid = False
    if previous and height > previous.height:
        rapid = sum(previous.height < step <= height for step in HEIGHTS) > 1
        seconds = current.sample_interval_s if current.quality == "simulated" else None
        seconds = seconds or (current.at - previous.at).total_seconds()
        if not rapid and previous.height >= 0 and seconds > 0:
            rate = (height - previous.height) * 60 / seconds
            eta = (settings.critical_cm - height) / rate
    reached = height >= settings.critical_cm
    if reached:
        stage, reason, eta = "emergency", "위험 수위에 도달했습니다.", 0
    elif rapid:
        stage, reason = "emergency", "여러 수위 단계가 동시에 감지됐습니다."
    elif eta is not None and eta <= 5:
        stage, reason = "emergency", "위험 수위까지 5분 이내입니다."
    elif eta is not None and eta <= settings.warning_min:
        stage, reason = "warning", "위험 수위까지 경고 기준 시간 이내입니다."
    elif current.floor_wet:
        stage, reason = "interest", "실내 물 유입이 감지됐습니다."
    elif rain_mm is not None and rain_mm >= 30:
        stage, reason = "interest", "최근 1시간 강수량이 시연 기준 30mm 이상입니다."
    else:
        stage, reason = "normal", "실내 물 유입이 감지되지 않았습니다."
    return {"level": stage, "message": reason, "rate_cm_min": rate, "eta_min": eta}
