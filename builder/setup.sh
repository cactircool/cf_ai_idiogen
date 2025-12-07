#!/bin/bash

# This is for ubuntu environments with systemctl setup
# Usage: setup.sh [PATH_TO_IDIOGEN_GO_SERVER]

sudo systemctl stop idiogen.service
sudo systemctl disable idiogen.service
sudo systemctl daemon-reload

go build -o idiogen-server $1
sudo mv idiogen-server /usr/local/bin/

sudo mkdir -p /var/cache/emscripten
sudo chown -R www-data:www-data /var/cache/emscripten

sudo cat << EOF > /etc/idiogen.env
PORT=9657
EMSDK=/opt/emsdk
EMSCRIPTEN=/opt/emsdk/upstream/emscripten
PATH=/opt/emsdk:/opt/emsdk/upstream/emscripten:/opt/emsdk/node/22.16.0_64bit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
EM_CACHE=/var/cache/emscripten
EOF

sudo cat << EOF > /etc/systemd/system/idiogen.service
[Unit]
Description=IdioGen Compilation Server
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data

EnvironmentFile=/etc/idiogen.env

WorkingDirectory=/usr/local/bin
ExecStart=/usr/local/bin/idiogen-server

Restart=always
RestartSec=3

# Increase security
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable idiogen.service
sudo systemctl start idiogen.service
