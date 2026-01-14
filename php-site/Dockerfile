FROM php:8.1-apache

# 安装系统依赖和 PHP 扩展
RUN apt-get update && apt-get install -y \
    libpng-dev \
    libjpeg-dev \
    libfreetype6-dev \
    libzip-dev \
    libsqlite3-dev \
    zip \
    unzip \
    curl \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j$(nproc) gd pdo pdo_sqlite zip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 启用 Apache mod_rewrite
RUN a2enmod rewrite

# 设置工作目录
WORKDIR /var/www/html

# 复制应用文件
COPY php-site/ /var/www/html/

# 创建必要的目录并设置权限
RUN mkdir -p /var/www/html/storage \
    && mkdir -p /var/www/html/uploads \
    && chown -R www-data:www-data /var/www/html \
    && chmod -R 755 /var/www/html \
    && chmod -R 775 /var/www/html/storage \
    && chmod -R 775 /var/www/html/uploads

# 配置 PHP
RUN echo "upload_max_filesize = 100M" > /usr/local/etc/php/conf.d/uploads.ini \
    && echo "post_max_size = 100M" >> /usr/local/etc/php/conf.d/uploads.ini \
    && echo "memory_limit = 256M" >> /usr/local/etc/php/conf.d/uploads.ini \
    && echo "max_execution_time = 300" >> /usr/local/etc/php/conf.d/uploads.ini

# 配置 Apache
RUN echo '<Directory /var/www/html>' > /etc/apache2/conf-available/siyuan-share.conf \
    && echo '    Options Indexes FollowSymLinks' >> /etc/apache2/conf-available/siyuan-share.conf \
    && echo '    AllowOverride All' >> /etc/apache2/conf-available/siyuan-share.conf \
    && echo '    Require all granted' >> /etc/apache2/conf-available/siyuan-share.conf \
    && echo '</Directory>' >> /etc/apache2/conf-available/siyuan-share.conf \
    && a2enconf siyuan-share

# 暴露端口
EXPOSE 80

# 启动 Apache
CMD ["apache2-foreground"]
