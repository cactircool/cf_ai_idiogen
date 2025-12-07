#!/bin/bash

# This is for ubuntu environments with systemctl setup
# Usage: setup.sh [PATH_TO_IDIOGEN_GO_SERVER]

sudo systemctl stop idiogen-frontend.service
sudo systemctl disable idiogen-frontend.service
sudo systemctl daemon-reload

frontend_dir=$(realpath $1)
cd $frontend_dir
npm install
npm run build

sudo cat << EOF > /etc/systemd/system/idiogen-frontend.service
[Unit]
Description=IdioGen Frontend Server
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data

Environment=PORT=5634
Environment=NODE_ENV=production

WorkingDirectory=$frontend_dir
ExecStart=/usr/bin/npm start -- -p \${PORT}

Restart=always
RestartSec=3

# Increase security
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable idiogen-frontend.service
sudo systemctl start idiogen-frontend.service
