# Админка

Одно место, где смотреть аналитику и логи остальных сервисов BurningHouse и
управлять ролью админа. Сам ничего не хранит — при каждом обращении дёргает
`/internal/*` настроенных сервисов и отдаёт фронту. Дизайн — калий, сиреневое
пламя, см. `BurningHouse/Design/services.md` и `palette.md`.

Вход — тот же SSO, что и везде (`Auth/INTEGRATION.md`), но внутрь пускает,
только если у аккаунта есть claim `admin` в токене — его выдаёт Auth:

```bash
docker compose exec auth node server.js make-admin <логин>
docker compose exec auth node server.js revoke-admin <логин>
docker compose exec auth node server.js admins        # кто сейчас админ
```

## Как это работает

- **Браузер → Admin** — обычный SSO (authorization code + PKCE), как у
  «Финансов», «Что смотрим» и «Куда поедем?». Токен подписан на аудиторию
  `admin` и проверяется локально по JWKS.
- **Admin → остальные сервисы** — НЕ через этот токен: он годится только для
  самого Admin. Вместо этого — общий секрет `ADMIN_INTERNAL_KEY` в заголовке
  `X-Admin-Key`, тот же самый на Admin и на вызываемом сервисе (см.
  `Shared/admin-internal.js`, который каждый сервис держит у себя копией).
  Так каждый сервис остаётся самодостаточным: ему не нужно знать про клиента
  `admin` в auth и принимать чужую аудиторию токенов.

## Переменные окружения

| Переменная | Обязательна | Что |
|---|---|---|
| `AUTH_ISSUER` | да | адрес auth-сервиса |
| `AUTH_CLIENT_ID` | нет (по умолчанию `admin`) | id этого сервиса в auth |
| `ADMIN_INTERNAL_KEY` | да | общий секрет с `/internal/*` остальных сервисов |
| `SERVICES_JSON` | да | какие сервисы показывать — см. пример в `docker-compose.prod.yml` |
| `PORT`, `HOST` | нет | по умолчанию `8793` / `127.0.0.1` |

Один из элементов `SERVICES_JSON` обязан иметь `"id":"auth"` — через него
идёт вкладка «Пользователи» (список, роль админа, блокировка, разлогин).
Остальные сервисы показывают только «Обзор» и «Логи»: своих пользователей они
не ведут, аккаунтами заведует Auth.

## Локальный запуск

```bash
docker compose exec auth node server.js client-add admin "Админка" http://localhost:8793/
docker compose up --build
```

`ADMIN_INTERNAL_KEY` в `docker-compose.yml` — `dev-admin-key`, то же значение
должно быть у Auth/Финансов/Movies/Trip, поднятых локально (см. их
`docker-compose.yml` / `docker-compose.dev.yml` в `Auth/`).

## Деплой

Тот же принцип, что у остальных сервисов: пуш в `main` → GitHub Actions
собирает образ и пушит в Docker Hub → Watchtower на сервере сам подтягивает
новую версию (см. `Auth/README-deploy.md`). В секретах репозитория — только
`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`, SSH-ключа быть не должно.

nginx — `deploy/nginx-admin-443.conf`, `admin.burninghouse.ru`.
