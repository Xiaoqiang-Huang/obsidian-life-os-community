import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import { zipSync } from 'fflate';

export const WINDOWS_SDK_RUNTIME = Object.freeze({sdkVersion:'0.3.293',cliVersion:'2.1.293',platform:'win32',arch:'x64',entry:'claude.exe',sha256:'8693c4a02dde7441d0066ede68af8ddfc408bb982d77e12b506286268224e6fa'});
export async function sha256File(file) { const hash=crypto.createHash('sha256');for await(const part of createReadStream(file))hash.update(part);return hash.digest('hex'); }
async function plain(file) { if(await fs.realpath(file)!==file || !(await fs.lstat(file)).isFile())throw Error('SDK_PACKAGE_SOURCE_UNSAFE'); }
/** Offline, explicit local staging. Never downloads or executes a runtime,
 * overwrites an existing output, copies settings/data.json, or grants a licence.
 * Only the verified Windows x64 binary is currently accepted by this packager. */
export async function buildSdkDesktopPackage({root,output,runtimeSource,platform='win32',arch='x64',zip=true}) {
  if(platform!=='win32'||arch!=='x64')throw Error('SDK_PACKAGE_PLATFORM_UNVERIFIED');
  if(!root||!output||!runtimeSource||![root,output,runtimeSource].every(path.isAbsolute))throw Error('SDK_PACKAGE_ABSOLUTE_PATH_REQUIRED');
  root=path.resolve(root);output=path.resolve(output);runtimeSource=path.resolve(runtimeSource);
  if(await fs.realpath(root)!==root || await fs.realpath(path.dirname(output))!==path.dirname(output))throw Error('SDK_PACKAGE_PATH_UNSAFE');
  // Refuse the source tree itself, dependencies and all existing output paths.
  if(output===root||output.startsWith(path.join(root,'node_modules')+path.sep))throw Error('SDK_PACKAGE_OUTPUT_UNSAFE');
  try { await fs.lstat(output); throw Error('SDK_PACKAGE_OUTPUT_EXISTS'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  await plain(runtimeSource);
  if(await sha256File(runtimeSource)!==WINDOWS_SDK_RUNTIME.sha256)throw Error('SDK_PACKAGE_RUNTIME_INTEGRITY');
  const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')),pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  if(!/^[a-z0-9-]+$/.test(manifest.id)||!/^\d+\.\d+\.\d+$/.test(manifest.version)||pkg.version!==manifest.version||pkg.dependencies?.['@anthropic-ai/claude-agent-sdk']!==WINDOWS_SDK_RUNTIME.sdkVersion)throw Error('SDK_PACKAGE_VERSION_MISMATCH');
  const required=['main.js','manifest.json','styles.css','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','docs/sdk-desktop-installation.md'];
  const licences=(await fs.readdir(path.join(root,'docs/licenses/sdk'))).filter(f=>/^[A-Za-z0-9_.-]+$/.test(f)).map(f=>'docs/licenses/sdk/'+f);
  for(const f of [...required,...licences])await plain(path.join(root,f));
  await fs.mkdir(output);const plugin=path.join(output,manifest.id);await fs.mkdir(plugin);
  const copy=async(from,relative)=>{const dest=path.join(plugin,relative);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(from,dest);};
  for(const f of [...required,...licences])await copy(path.join(root,f),f);
  const rel=`runtime/claude-agent/${WINDOWS_SDK_RUNTIME.sdkVersion}/win32-x64/`;
  await copy(runtimeSource,rel+WINDOWS_SDK_RUNTIME.entry);
  if(await sha256File(path.join(plugin,rel,WINDOWS_SDK_RUNTIME.entry))!==WINDOWS_SDK_RUNTIME.sha256)throw Error('SDK_PACKAGE_RUNTIME_INTEGRITY');
  await fs.writeFile(path.join(plugin,rel,'manifest.json'),JSON.stringify(WINDOWS_SDK_RUNTIME,null,2)+'\n');
  await fs.writeFile(path.join(plugin,'DESKTOP_INSTALL.md'),`# Life OS ${manifest.version} Windows x64 local package\n\nThis package is not a published release or redistribution approval. Review the upstream SDK/runtime terms before distribution.\n\nSave edits and close/disable this plugin before a manual install. Back up the existing plugin directory. Copy the ${manifest.id} folder into the Vault's .obsidian/plugins directory, preserving existing data.json and sdk-state; never replace user notes. On re-enable use ordinary AI provider/model settings only. No CLI paths or SDK profiles are required.\n\nCommunity three-file updates do not supply a missing runtime. An existing matching runtime is preserved and verified on AI use; a missing/corrupt runtime requires a complete matching desktop package, not a fallback engine. Do not automatically download executable code.\n\nWindows x64 only. macOS/Linux/Windows ARM and mobile AI are not accepted by this packaging verification. Mobile non-AI functionality is not changed.\n`);
  const list=async(dir,base='')=>{let out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const relative=path.posix.join(base,e.name);out.push(...(e.isDirectory()?await list(path.join(dir,e.name),relative):[relative]));}return out.sort();};
  const files=[];for(const f of await list(plugin)){const file=path.join(plugin,f);files.push({path:f,size:(await fs.stat(file)).size,sha256:await sha256File(file)});}
  const receipt={schemaVersion:1,pluginId:manifest.id,pluginVersion:manifest.version,sdkVersion:WINDOWS_SDK_RUNTIME.sdkVersion,platform,arch,runtimePin:WINDOWS_SDK_RUNTIME,redistributionReviewRequired:true,settingsIncluded:false,modelsInvoked:0,files};
  await fs.writeFile(path.join(plugin,'DESKTOP_PACKAGE.json'),JSON.stringify(receipt,null,2)+'\n');
  let archive;
  if(zip){const entries={};for(const f of await list(plugin))entries[manifest.id+'/'+f]=[new Uint8Array(await fs.readFile(path.join(plugin,f))),{mtime:new Date(2020,0,1,0,0,0)}];archive=path.join(output,`lifeos-${manifest.version}-win32-x64.zip`);await fs.writeFile(archive,zipSync(entries,{level:1}));await fs.writeFile(path.join(output,'SHA256SUMS'),`${await sha256File(archive)}  ${path.basename(archive)}\n`);}
  return {...receipt,pluginDirectory:plugin,archive};
}
