#!/usr/bin/env node
import { conformanceMain } from '../dist/index.js';

process.exitCode = await conformanceMain({ argv: process.argv.slice(2) });
