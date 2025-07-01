#!/usr/bin/env node

import { Command } from "commander";
import { injectDefineOptions } from "./inject";
import path from "path";

const program = new Command();

program
    .name("inject-define-options")
    .description("Inject or override defineOptions({ name }) in Vue components.")
    .requiredOption("-r, --route <file>", "Path to route file (e.g. localAuthRoute.ts)")
    .option("-v, --views <dir>", "Views base directory", "./src/views")
    .option("-e, --exclude <dirs...>", "Exclude directories (relative to views)", []) // ⬅️ 新增
    .parse();

const options = program.opts();

injectDefineOptions({
    routeFile: path.resolve(process.cwd(), options.route),
    viewsDir: path.resolve(process.cwd(), options.views),
    excludeDirs: options.exclude || []
});