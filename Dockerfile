FROM node:24-alpine

WORKDIR /app

# Копируем только то, что реально нужно в рантайме. Зависимостей нет вовсе —
# как и у остальных сервисов BurningHouse (SQLite — встроенный node:sqlite).
# На смонтированном /app/data (см. docker-compose volumes) теперь два файла:
# health-state.json (как раньше) и metrics.db (см. план «Метрики», server.js
# runHealthCheck) — история /internal/stats по времени, раз в час. Текущие
# цифры «сейчас» (Обзор/детали сервиса) по-прежнему не хранятся — дёргаются
# из /internal/* остальных сервисов на лету.
COPY *.js ./
COPY index.html ./
COPY assets/ ./assets/

RUN set -e; \
    for f in server.js auth-client.js mailer.js index.html; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    node --check server.js && node --check auth-client.js && node --check mailer.js

# Каталог данных: health-state.json (см. server.js). В контейнере он
# смонтирован томом — см. docker-compose.yml. Создаём и отдаём node:node
# ДО USER node — том создаётся на первом старте от рута и без этого
# mkdirSync в server.js падает EACCES (см. Puzzle/Dockerfile, тот же приём).
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV HOST=0.0.0.0
ENV PORT=8793
ENV DATA_DIR=/app/data

EXPOSE 8793
VOLUME ["/app/data"]

CMD ["node", "server.js"]
