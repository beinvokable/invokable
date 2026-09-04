#!/usr/bin/env node
import { cli } from '@invokable/core';
import tool from '../src/tool.mjs';

await cli(tool);
