// Rebuild the deployed portal lineage with chat-only additions. Never publish
// the workspace's unrelated, not-yet-approved portal intake/financial changes.
import { execFileSync } from "node:child_process";
import { mkdir, symlink, cp, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const destination = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && destination.startsWith(`${workspace}/.local/`), "Use a fresh private staging directory");
await mkdir(destination, { recursive: false });
const archive = path.join(destination, "source.tar");
execFileSync("git", ["archive", "-o", archive, "4cbb561", "artifacts/crm-dashboard", "lib",
  "package.json", "pnpm-workspace.yaml", "tsconfig.base.json"], { cwd: workspace });
execFileSync("tar", ["-xf", archive, "-C", destination]);
await symlink(path.join(workspace, "node_modules"), path.join(destination, "node_modules"));
const artifact = "artifacts/crm-dashboard";
await symlink(path.join(workspace, artifact, "node_modules"), path.join(destination, artifact, "node_modules"));
const approvedEntrypoints = {
  "src/App.tsx": "385d2ec33959b9ba2d9a503362b572f2dfb22aba15dfadffc9548f134e481165",
  "src/components/CrmShell.tsx": "5bd117322960d34fb3e1ab6ef3529d4bbf624b5062773f28be5b039f4e7352c6",
};
for (const [relative, expected] of Object.entries(approvedEntrypoints)) {
  assert.equal(createHash("sha256").update(await readFile(path.join(workspace, artifact, relative))).digest("hex"),
    expected, "Entrypoint changed outside the approved chat additions; re-establish the bounded release scope");
}
for (const relative of ["src/chat", "src/App.tsx", "src/components/CrmShell.tsx"]) {
  await cp(path.join(workspace, artifact, relative), path.join(destination, artifact, relative), { recursive: true });
}
const portalPath = path.join(destination, artifact, "src/customer-portal/Portal.tsx");
const portalOriginal = await readFile(portalPath, "utf8");
let portal = portalOriginal;
const change = (old, next) => {
  assert.equal(portal.split(old).length, 2, "Expected unique baseline portal marker");
  portal = portal.replace(old, () => next);
};
change("import './portal.css';", "import './portal.css';\nimport { CustomerChat } from '@/chat/CustomerChat';\nimport { usePresence } from '@/chat/Presence';");
change("  const [location] = useLocation();\n  useEffect(() => {\n    const titles:", `  const [location] = useLocation();
  usePresence(portalApi.chatPresence, Boolean(profile.identityReady));
  const chat = useQuery({ queryKey: ['customer', 'chat-thread'], queryFn: portalApi.chatThread,
    enabled: Boolean(profile.identityReady), refetchInterval: 10000, retry: false });
  useEffect(() => {
    const titles:`);
const adviceLink = '      <Link href="/customer/advice" aria-current={location === \'/customer/advice\' ? \'page\' : undefined} data-testid="link-customer-advice">مشاوره هوشمند</Link>';
change(adviceLink, adviceLink + '\n      <Link href="/customer/advice/chat" aria-current={location === \'/customer/advice/chat\' ? \'page\' : undefined} data-testid="link-customer-chat">گفتگو با کارشناس{chat.data?.unreadCount ? ` (${chat.data.unreadCount.toLocaleString(\'fa-IR\')})` : \'\'}</Link>');
const contact = testId => `    <section className="cp-card" style={{ marginBottom: 16 }}><Link href="/customer/advice/chat" className="cp-link" data-testid="${testId}">گفتگو با کارشناس فروش و ارسال تصویر، فایل یا پیام صوتی ←</Link></section>`;
change("function Overview({ profile }: { profile: Profile }) {\n  const applications = useQuery({ queryKey: ['customer', 'active-applications'], queryFn: portalApi.activeApplications });\n  return <>",
  "function Overview({ profile }: { profile: Profile }) {\n  const applications = useQuery({ queryKey: ['customer', 'active-applications'], queryFn: portalApi.activeApplications });\n  return <>\n" + contact("link-home-chat"));
const adviceHead = '  return <><div className="cp-pagehead"><div><p className="cp-eyebrow">راهنمای انتخاب</p><h1 className="cp-title">گفتگو برای یک تصمیم بهتر.</h1><p className="cp-lede">سؤال‌تان را بپرسید؛ شرایط نهایی هر طرح در مرحله درخواست توسط سامانه بررسی می‌شود.</p></div></div>';
change(adviceHead, adviceHead + "\n" + contact("link-advice-chat"));
change('    <Route path="/customer/advice" component={Advice} />',
  '    <Route path="/customer/advice" component={Advice} />\n    <Route path="/customer/advice/chat" component={CustomerChat} />');
await writeFile(portalPath, portal);
const apiPath = path.join(destination, artifact, "src/customer-portal/api.ts");
const apiOriginal = await readFile(apiPath, "utf8");
const chatMethods = `  chatPresence: () => request('/chat/presence', { method: 'POST' }),
  chatThread: () => request<ChatThread>('/chat/thread'),
  chatMessages: (beforeId?: number) => request<ChatPage>(\`/chat/messages\${beforeId ? \`?beforeId=\${beforeId}\` : ''}\`),
  chatSend: (clientId: string, text: string, file?: File) => {
    const form = new FormData(); form.set('clientId', clientId); form.set('text', text);
    if (file) form.set('file', file);
    return request<ChatMessage>('/chat/messages', { method: 'POST', body: form });
  },
  chatRead: (lastMessageId: number) => request('/chat/read', { method: 'POST', body: json({ lastMessageId }) }),
`;
assert.equal(apiOriginal.split("export const portalApi = {").length, 2);
const currentApi = await readFile(path.join(workspace, artifact, "src/customer-portal/api.ts"), "utf8");
const chatTypes = ["ChatThread", "ChatMessage", "ChatPage"].map(name => {
  const matches = currentApi.split("\n").filter(line => line.startsWith(`export type ${name} = `));
  assert.equal(matches.length, 1, "Expected one chat-only DTO declaration");
  return matches[0];
});
await writeFile(apiPath, apiOriginal.replace("export const portalApi = {", () => "export const portalApi = {\n" + chatMethods) +
  "\n" + chatTypes.join("\n") + "\n");
execFileSync("pnpm", ["run", "build"], {
  cwd: path.join(destination, artifact), stdio: "inherit",
  env: { ...process.env, BASE_PATH: "/", PORT: "5173" },
});
const publicDir = path.join(destination, artifact, "dist/public");
assert.ok(!(await readFile(path.join(publicDir, "index.html"), "utf8")).includes("/crm-dashboard/assets/"));
assert.ok((await readdir(path.join(publicDir, "assets"))).some(name => name.endsWith(".js")));
console.log("Bounded chat frontend ready:", publicDir);
