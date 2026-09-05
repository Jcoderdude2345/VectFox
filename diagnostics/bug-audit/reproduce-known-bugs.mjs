// The diagnostic failures have been promoted to permanent regression tests.
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..');
const files=['chunking','eventbase-extractor','agentic-retrieval','emotion-classifier','png-export','prompts-i18n'].map(name=>`tests/${name}.test.js`);
const result=spawnSync(process.execPath,[path.join(root,'node_modules/vitest/vitest.mjs'),'run',...files,'--reporter=dot'],{cwd:root,stdio:'inherit'});
process.exitCode=result.status??1;
