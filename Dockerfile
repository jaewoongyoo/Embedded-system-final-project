FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY floodguard ./floodguard
COPY dashboard ./dashboard
COPY simulator/style.css ./simulator/style.css
CMD ["uvicorn", "floodguard.server:app", "--host", "0.0.0.0"]
