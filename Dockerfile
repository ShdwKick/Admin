FROM node:24-alpine

WORKDIR /app

# Копируем только то, что реально нужно в рантайме. Зависимостей нет вовсе —
# как и у остальных сервисов BurningHouse. Своей базы Admin по-прежнему не
# ведёт — только health-state.json на смонтированном /app/data (см. server.js
# runHealthCheck, docker-compose volumes), сама аналитика/логи всё так же
# дёргаются из /internal/* остальных сервисов на лету, не хранятся.
COPY *.js ./
COPY index.html ./
COPY assets/ ./assets/

RUN set -e; \
    for f in server.js auth-client.js mailer.js index.html; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    node --check server.js && node --check auth-client.js && node --check mailer.js

USER node

ENV HOST=0.0.0.0
ENV PORT=8793

EXPOSE 8793

CMD ["node", "server.js"]
