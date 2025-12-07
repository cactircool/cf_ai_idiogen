#!/bin/bash

SCRIPT_DIR=$(dirname $0)

read -p "Deploy workflow on setup? (requires a GUI browser on current device) " d_workflow

if [ "$d_workflow" = "Y" ] || [ "$d_workflow" = "y" ]; then
	cd $SCRIPT_DIR/workflow
	npm install
	npm run types
	npm run deploy
fi

sudo $SCRIPT_DIR/builder/setup.sh $SCRIPT_DIR/builder/main.go
sudo $SCRIPT_DIR/frontend/setup.sh $SCRIPT_DIR/frontend
