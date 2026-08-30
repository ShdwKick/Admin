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
| `PEXELS_API_KEY` | нет | ключ [pexels.com](https://www.pexels.com/api/) для вкладки «Импорт» у Puzzle (наполнение библиотеки готовыми фото). Без него вкладка отвечает 503 |
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
должно быть у Auth/Финансов/Movies/Trip/Puzzle, поднятых локально (см. их
`docker-compose.yml` / `docker-compose.dev.yml` в `Auth/`).

## Деплой

Тот же принцип, что у остальных сервисов: пуш в `main` → GitHub Actions
собирает образ и пушит в Docker Hub → Watchtower на сервере сам подтягивает
новую версию (см. `Auth/README-deploy.md`). В секретах репозитория — только
`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`, SSH-ключа быть не должно.

nginx — `deploy/nginx-admin-443.conf`, `admin.burninghouse.ru`.

### ADMIN_INTERNAL_KEY на сервере

`docker-compose.prod.yml` ссылается на переменную подстановкой
(`${ADMIN_INTERNAL_KEY:-}`), а не хранит значение сам — так секрет не уходит в
репозиторий и не затирается очередным `git pull`. Значение — в файле `.env`
рядом с compose (как `POISKKINO_API_KEY` у Movies, `GIGACHAT_AUTH_KEY` у Trip):

```bash
cd ~/admin
bash set-env.sh ADMIN_INTERNAL_KEY 'то же значение, что у Auth/Финансов/Movies/Trip/Puzzle'
docker compose -f docker-compose.prod.yml up -d   # перечитать .env
```

`set-env.sh` (`Shared/set-env.sh`, копия рядом с compose — как `admin-internal.js`)
меняет только эту одну строку, не трогая остальные секреты в `.env`, если они
там уже есть (у Movies это `POISKKINO_API_KEY`, у Trip — `GIGACHAT_AUTH_KEY`):
обычный `printf ... > .env` перезаписывает файл целиком и стирает их.

**Одно и то же значение нужно так же положить в `.env` всех остальных пяти
сервисов** и там же поднять их `up -d` — иначе `/internal/*` будет отвечать
403 (ключи не совпали), а не 500: незаданный ключ там намеренно безопасный
дефолт, а не ошибка конфигурации. `.env` не коммитьте — он в `.gitignore`.
