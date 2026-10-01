import {cpSync, existsSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('../../../docs/api/', import.meta.url));
const target = fileURLToPath(new URL('../public/api-docs/', import.meta.url));
if (existsSync(source)) {
  mkdirSync(target, {recursive: true});
  cpSync(source, target, {recursive: true});
} else if (!existsSync(`${target}/openapi.yaml`)) {
  throw new Error('Prepare docs/api into services/frontend/public/api-docs before building the Docker image.');
}
