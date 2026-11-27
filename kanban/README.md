# Задачник-канбан

Доска задач для команды «Море трафика». Задачи — карточки, которые перетаскиваются по колонкам:

**Идеи → В работе → Ждёт → Готово**

- **Идеи** — мысли «в долгую».
- **Ждёт** — задачи, где чего-то не хватает. На карточке видно, чего именно ждём.
- **Готово** — показываются выполненные за последние 2 недели, более старые спрятаны под кнопкой.
- **Повторять каждую неделю** — галочка в карточке. В понедельник такая задача сама вернётся из «Готово» в «В работе».
- **Трекинг статусов**: у каждой карточки есть история («кто, когда и куда передвинул») и полоска «сколько времени провела в каждой колонке». Если задача лежит «В работе» или «Ждёт» дольше 5 дней, счётчик на карточке краснеет.
- Изменения коллег появляются у всех сами, без обновления страницы (в течение ~4 секунд).
- Вход по общему паролю команды.

Все данные хранятся **на вашем сервере** в одном файле `data/board.json`. Раз в сутки сервер сам делает копию в `data/backups/` и хранит последние 30 копий.

Внешних библиотек нет — нужен только Node.js (программа, которая запускает сервер).

---

## Попробовать у себя на компьютере

1. Установите Node.js с сайта https://nodejs.org (кнопка LTS).
2. Откройте терминал в папке `kanban` и выполните:
   ```
   node server.js
   ```
3. Откройте в браузере http://localhost:3000

Без пароля вход открыт — это только для проверки на своём компьютере.

---

## Установка на VPS (Ubuntu / Debian)

Команды ниже вводятся по очереди в терминал сервера. Подключиться к серверу: `ssh root@IP-вашего-сервера`.

### 1. Поставить Node.js

```
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git
```

### 2. Скачать задачник

```
git clone https://github.com/kkclaude99-sys/zadachnik.git /opt/zadachnik
useradd --system --home /opt/zadachnik zadachnik
mkdir -p /opt/zadachnik/kanban/data
chown -R zadachnik /opt/zadachnik/kanban/data
```

### 3. Задать пароль команды

Замените `ПРИДУМАЙТЕ-ПАРОЛЬ` на свой пароль:

```
cat > /etc/zadachnik.env <<'EOF'
TEAM_PASSWORD=ПРИДУМАЙТЕ-ПАРОЛЬ
PORT=3000
EOF
chmod 600 /etc/zadachnik.env
```

### 4. Запустить как службу

Служба — это когда сервер сам стартует при перезагрузке VPS и сам поднимается, если упал.

```
cp /opt/zadachnik/kanban/deploy/zadachnik.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zadachnik
systemctl status zadachnik
```

В ответе должно быть зелёное `active (running)`.

Теперь задачник открывается по адресу `http://IP-вашего-сервера:3000`.

### 5. (Очень желательно) Домен и HTTPS

Без HTTPS пароль идёт по сети в открытом виде. Если есть домен (например `zadachnik.вашсайт.ru`), направьте его на IP сервера (A-запись у регистратора домена) и поставьте Caddy — он сам выпустит бесплатный сертификат:

```
apt-get install -y caddy
cp /opt/zadachnik/kanban/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile        # заменить zadachnik.example.ru на свой домен
echo "HOST=127.0.0.1" >> /etc/zadachnik.env   # закрыть прямой вход через :3000
systemctl restart zadachnik caddy
```

Задачник откроется по адресу `https://ваш-домен`.

### 6. Перенести старые задачи из Supabase

Сначала разбудите старую базу на https://supabase.com/dashboard (кнопка **Restore project**, подождать пару минут). Потом:

```
systemctl stop zadachnik
cd /opt/zadachnik/kanban && sudo -u zadachnik node scripts/import-supabase.js
systemctl start zadachnik
```

Повторный запуск ничего не задвоит.

---

## Обновить задачник до новой версии

```
cd /opt/zadachnik && git pull && systemctl restart zadachnik
```

Данные (`data/`) при обновлении не трогаются.

## Если что-то пошло не так

- Посмотреть журнал сервера: `journalctl -u zadachnik -n 50`
- Вернуть данные из копии: остановить службу, скопировать нужный файл из `data/backups/` на место `data/board.json`, запустить службу.
