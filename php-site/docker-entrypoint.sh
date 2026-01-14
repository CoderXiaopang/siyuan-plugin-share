#!/bin/bash

# 确保 storage 和 uploads 目录存在并有正确权限
echo "Setting up directories and permissions..."

# 如果目录不存在则创建
mkdir -p /var/www/html/storage
mkdir -p /var/www/html/uploads

# 设置所有者为 www-data
chown -R www-data:www-data /var/www/html/storage
chown -R www-data:www-data /var/www/html/uploads

# 设置权限
chmod -R 775 /var/www/html/storage
chmod -R 775 /var/www/html/uploads

echo "Directories ready. Starting Apache..."

# 启动 Apache
exec apache2-foreground
