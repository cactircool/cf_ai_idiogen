#!/bin/bash

SCRIPT_DIR=$(dirname $0)

cd $SCRIPT_DIR/workflow
npm install
npm run types
npm run deploy

sudo $SCRIPT_DIR/builder/setup.sh $SCRIPT_DIR/builder/main.go
sudo $SCRIPT_DIR/frontend/setup.sh $SCRIPT_DIR/frontend
