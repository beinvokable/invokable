#!/usr/bin/env node
import { createMain } from '../dist/index.js';

process.exitCode = await createMain({ argv: process.argv.slice(2) });
