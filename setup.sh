#!/bin/bash

SCRIPT_DIR=$(dirname $0)
sudo $SCRIPT_DIR/builder/setup.sh $SCRIPT_DIR/builder/main.go
sudo $SCRIPT_DIR/frontend/setup.sh $SCRIPT_DIR/frontend
