import path from 'node:path';
import { exists, listFiles, readJson, writeJson } from '../util/fsx.js';

export class RawStore {
  constructor(dir) {
    this.dir = dir;
  }

  file(id) {
    return path.join(this.dir, String(id) + '.json');
  }

  has(id) {
    return exists(this.file(id));
  }

  read(id) {
    return readJson(this.file(id));
  }

  write(record) {
    writeJson(this.file(record.id), record);
    return record;
  }

  ids() {
    return listFiles(this.dir).map((f) => f.replace(/\.json$/, ''));
  }

  all() {
    return this.ids().map((id) => this.read(id)).filter(Boolean);
  }
}
