# ============================================================================
#  WebHafen — Image: Caddy (Webserver) + PHP-FPM (für PHP-Sites wie Montrigor)
#                    + Node.js (Verwaltung, Analytics) + Supervisor
# ============================================================================
FROM alpine:3.21

RUN apk add --no-cache \
      caddy supervisor nodejs unzip zip tzdata curl \
      php83 php83-fpm php83-opcache php83-session php83-ctype php83-fileinfo \
      php83-mbstring php83-openssl php83-curl php83-gd php83-iconv \
      php83-simplexml php83-dom php83-xml php83-tokenizer \
      php83-pdo php83-pdo_sqlite php83-sqlite3 php83-pdo_mysql \
 && (addgroup -S www-data 2>/dev/null || true) \
 && (adduser -S -D -H -G www-data www-data 2>/dev/null || true)

# PHP-Einstellungen: großzügige Upload-Limits (große Archiv-Ordner!)
RUN { \
      echo 'upload_max_filesize = 256M'; \
      echo 'post_max_size = 300M'; \
      echo 'max_file_uploads = 400'; \
      echo 'max_execution_time = 300'; \
      echo 'memory_limit = 512M'; \
      echo 'expose_php = Off'; \
    } > /etc/php83/conf.d/99-webhafen.ini

# PHP-FPM-Pool: läuft als www-data auf 127.0.0.1:9000 (nur im Container)
RUN { \
      echo '[www]'; \
      echo 'user = www-data'; \
      echo 'group = www-data'; \
      echo 'listen = 127.0.0.1:9000'; \
      echo 'pm = dynamic'; \
      echo 'pm.max_children = 10'; \
      echo 'pm.start_servers = 2'; \
      echo 'pm.min_spare_servers = 1'; \
      echo 'pm.max_spare_servers = 3'; \
      echo 'clear_env = no'; \
      echo 'catch_workers_output = yes'; \
    } > /etc/php83/php-fpm.d/www.conf

COPY app /app
COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
