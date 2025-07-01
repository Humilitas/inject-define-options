import * as fs from "fs";
import * as path from "path";
import { Project, SyntaxKind } from "ts-morph";

/**
 * 为 Vue 组件注入 defineOptions({ name })，基于路由文件中的 name + component 信息。
 *
 * @param config.routeFile - 路由定义文件路径（如 localAuthRoute.ts）
 * @param config.viewsDir - views 根目录路径（如 src/views）
 * @param config.excludeDirs - 可选，要排除的目录数组（如 ['error', 'demo']）
 */
export function injectDefineOptions(config: {
    routeFile: string;
    viewsDir: string;
    excludeDirs?: string[];
}) {
    const { routeFile, viewsDir, excludeDirs = [] } = config;

    // 使用 ts-morph 加载路由文件为 AST 项目
    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(routeFile);

    // 找到 export default 语句（期望是一个数组）
    const routeExport = sourceFile.getFirstDescendantByKind(SyntaxKind.ExportAssignment);
    if (!routeExport) {
        console.error("❌ 找不到 export default 语句");
        return;
    }

    // 获取 export default 的表达式
    const exportExpr = routeExport.getExpression();
    let routeArray;

    // ✅ 情况 1：直接数组表达式
    if (exportExpr.getKind() === SyntaxKind.ArrayLiteralExpression) {
        routeArray = exportExpr.asKind(SyntaxKind.ArrayLiteralExpression);
    }

    // ✅ 情况 2：类型断言：[] as Array<...>
    else if (exportExpr.getKind() === SyntaxKind.AsExpression) {
        const innerExpr = exportExpr.asKind(SyntaxKind.AsExpression)?.getExpression();
        if (innerExpr?.getKind() === SyntaxKind.ArrayLiteralExpression) {
            routeArray = innerExpr.asKind(SyntaxKind.ArrayLiteralExpression);
        }
    }

    // ✅ 情况 3：export default routes（引用标识符）
    else if (exportExpr.getKind() === SyntaxKind.Identifier) {
        const identifier = exportExpr.asKind(SyntaxKind.Identifier);
        const decl = identifier?.getDefinitions()?.[0]?.getDeclarationNode();

        if (decl?.getKind() === SyntaxKind.VariableDeclaration) {
            const init = decl.asKind(SyntaxKind.VariableDeclaration)?.getInitializer();

            // export default routes = [] 或 routes = [] as Array<...>
            if (init?.getKind() === SyntaxKind.ArrayLiteralExpression) {
                routeArray = init.asKind(SyntaxKind.ArrayLiteralExpression);
            } else if (init?.getKind() === SyntaxKind.AsExpression) {
                const inner = init.asKind(SyntaxKind.AsExpression)?.getExpression();
                if (inner?.getKind() === SyntaxKind.ArrayLiteralExpression) {
                    routeArray = inner.asKind(SyntaxKind.ArrayLiteralExpression);
                }
            }
        }
    }

    if (!routeArray) {
        console.error("❌ export default 的不是数组表达式，也不是指向数组变量");
        return;
    }

    // 提取数组中每一项（对象字面量形式）
    const routeObjects = routeArray.getElements().filter(e =>
        e.getKind() === SyntaxKind.ObjectLiteralExpression
    );

    type RouteItem = { name: string; relativePath: string };
    const matchedRoutes: RouteItem[] = [];

    // 遍历每个路由项，提取 name 和 component 中的 import 路径
    for (const route of routeObjects) {
        const obj = route.asKind(SyntaxKind.ObjectLiteralExpression);
        if (!obj) continue;

        const nameProp = obj.getProperty("name");
        const compProp = obj.getProperty("component");

        // 只处理包含 name 和 component 的项
        if (!nameProp || !compProp) continue;

        // 提取 name 的文本值（name: "XXX"）
        const nameText = nameProp.getFirstDescendantByKind(SyntaxKind.StringLiteral)?.getLiteralText();

        // 提取 component 的箭头函数体
        const arrowFn = compProp.getFirstDescendantByKind(SyntaxKind.ArrowFunction);
        if (!nameText || !arrowFn) continue;

        // 查找 import("@/views/xxx") 调用
        const importCall = arrowFn.getDescendantsOfKind(SyntaxKind.CallExpression).find(call =>
            call.getExpression().getText() === "import"
        );
        if (!importCall) continue;

        // 提取 import 参数的路径字符串
        const importArg = importCall.getArguments()[0];
        const importPath = importArg?.asKind(SyntaxKind.StringLiteral)?.getLiteralText();

        // 仅处理以 @/views 开头的路径
        if (!importPath?.startsWith("@/views/")) continue;

        // 相对 views 目录的路径
        const relativePath = importPath.replace("@/views/", "");
        matchedRoutes.push({ name: nameText, relativePath });
    }

    if (matchedRoutes.length === 0) {
        console.warn("⚠️ 没有匹配到任何含 component 的路由项");
        return;
    }

    // 创建另一个项目用于处理 Vue 文件内部 script 内容
    const vueProject = new Project();

    // 遍历每个匹配到的组件路径
    matchedRoutes.forEach(({ name, relativePath }) => {
        // 如果路径中包含任一排除目录，则跳过
        if (excludeDirs.some(dir => relativePath.split("/").includes(dir))) {
            console.log(`⏭️  忽略目录下组件: ${relativePath}`);
            return;
        }

        // 拼接组件对应的 .vue 文件路径
        const vueFilePath = path.join(
            viewsDir,
            relativePath.endsWith(".vue") ? relativePath : relativePath + ".vue"
        );

        // 如果目标 .vue 文件不存在，跳过
        if (!fs.existsSync(vueFilePath)) {
            console.warn(`⚠️  未找到文件: ${vueFilePath}`);
            return;
        }

        // 要注入的 defineOptions 行
        const defineLine = `defineOptions({ name: "${name}" });`;

        let content = fs.readFileSync(vueFilePath, "utf-8");

        // 匹配第一个 <script> 标签（含属性）
        const scriptRegex = /<script([^>]*)>([\s\S]*?)<\/script>/;
        const match = content.match(scriptRegex);

        if (match) {
            // 如果已存在 <script> 块，尝试插入或替换 defineOptions

            const attrs = match[1];         // <script> 标签的属性
            let scriptContent = match[2];   // script 标签内代码
            const oldBlock = match[0];      // 整个 <script> 标签块

            if (scriptContent.includes("defineOptions")) {
                // 若已有 defineOptions，直接替换成新的内容（覆盖）
                scriptContent = scriptContent.replace(
                    /defineOptions\s*\(\s*\{[^}]*\}\s*\)\s*;?/,
                    defineLine
                );
            } else {
                // 若无 defineOptions，尝试插入到最后一个 import 后面
                const sourceFile = vueProject.createSourceFile("temp.ts", scriptContent, { overwrite: true });
                const imports = sourceFile.getImportDeclarations();
                const insertPos = imports.length > 0 ? imports.at(-1)!.getEnd() + 1 : 0;

                scriptContent =
                    insertPos > 0
                        ? scriptContent.slice(0, insertPos) + `\n${defineLine}\n` + scriptContent.slice(insertPos)
                        : `${defineLine}\n${scriptContent}`;
            }

            // 构造新的 script 标签，替换原始内容
            const newScript = `<script${attrs}>\n${scriptContent.trim()}\n</script>`;
            const newContent = content.replace(oldBlock, newScript);

            // 写入 .vue 文件
            fs.writeFileSync(vueFilePath, newContent, "utf-8");
            console.log(`✅ 处理: ${vueFilePath}`);
        } else {
            // 若文件中没有 <script>，则新建一个 <script setup> 块
            const newContent = `<script setup>\n${defineLine}\n</script>\n` + content;
            fs.writeFileSync(vueFilePath, newContent, "utf-8");
            console.log(`✨ 新增 <script setup> 到: ${vueFilePath}`);
        }
    });
}
