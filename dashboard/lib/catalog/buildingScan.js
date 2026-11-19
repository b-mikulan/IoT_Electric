const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const { randomUUID, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");

const activeStates = new Set(["starting", "running", "stopping", "indexing"]);
const validId = id => typeof id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const failure = (message, status = 409, code = "CATALOG_SCAN_UNAVAILABLE") => Object.assign(new Error(message), { status, code });
const workerScript = path.join(__dirname, "catalogWorker.js");
function workerEnvironment() {
  const allowed = new Set(["PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG", "LC_ALL"]);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))), PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
}
function runWorker(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, { workerData: data });
    let result;
    worker.on("message", message => { result = message; });
    worker.on("error", () => reject(failure("Obrada kataloga nije uspjela.", 500)));
    worker.on("exit", code => {
      if (code || !result || result.error) reject(failure(result?.error || "Obrada kataloga nije završena.", 500));
      else resolve(result);
    });
  });
}

class BuildingScan extends EventEmitter {
  constructor({ directory, config, poller, python = process.platform === "win32" ? "python" : "python3", caFile,
    spawnImpl = spawn, workerImpl = runWorker, delay = 3 }) {
    super();
    Object.assign(this, { directory, config, poller, python, caFile, spawnImpl, workerImpl, delay });
    this.active = null;
    this.closing = false;
    this.script = path.resolve(__dirname, "../../../tools/ews-topology/admin_scan.py");
  }
  get enabled() { return !this.config.demoMode && Boolean(this.directory && this.config.username && this.config.password && fs.existsSync(this.script)); }
  get busy() { return Boolean(this.active); }
  source() { return createHash("sha256").update(this.config.middlewareUrl.replace(/\/$/, "")).digest("hex"); }
  jobPath(id) {
    if (!validId(id)) throw failure("Snimka nije pronađena.", 404);
    return path.join(this.directory, id);
  }
  read(id) {
    if (this.active?.job.id === id) return structuredClone(this.active.job);
    try {
      const job = JSON.parse(fs.readFileSync(path.join(this.jobPath(id), "job.json"), "utf8"));
      if (job.id !== id || !job.state) throw new Error();
      if (activeStates.has(job.state)) { job.state = "interrupted"; job.message = "Server je prekinut. Spremljeni napredak možeš nastaviti."; }
      job.canResume = job.source === this.source() && fs.existsSync(path.join(this.jobPath(id), "checkpoint.sqlite")) && job.state !== "completed";
      return job;
    } catch { throw failure("Snimka nije pronađena ili nije čitljiva.", 404); }
  }
  publicJob(job) {
    const { source, ...visible } = job;
    const dir = this.jobPath(job.id);
    visible.files = this.active?.job.id === job.id ? [] : [
      ...(job.exportsReady ? ["inventory.csv", "topology.json"] : []), "checkpoint.sqlite", ...(job.catalog ? ["catalog.sqlite"] : []),
    ].filter(file => fs.existsSync(path.join(dir, file)));
    return visible;
  }
  status() {
    const jobs = fs.existsSync(this.directory) ? fs.readdirSync(this.directory).filter(validId).flatMap(id => {
      try { return [this.publicJob(this.read(id))]; } catch { return []; }
    }).sort((a, b) => Number(b.id === this.active?.job.id) - Number(a.id === this.active?.job.id) || b.createdAt.localeCompare(a.createdAt)).slice(0, 30) : [];
    return { enabled: this.enabled, busy: this.busy, activeId: this.active?.job.id || null, jobs };
  }
  save(job) {
    job.updatedAt = new Date().toISOString();
    const file = path.join(this.jobPath(job.id), "job.json"), temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  notify() { this.emit("change"); }
  start(body = {}) {
    if (!this.enabled || this.closing) throw failure("Skeniranje zahtijeva stvarni način rada, backend vjerodajnice i instaliran Python mapper.");
    if (this.active) throw failure("Skeniranje je već u tijeku.");
    if (body.confirmPause !== true) throw failure("Potvrdi privremenu pauzu očitanja i upravljanja.", 400);
    let job;
    const maxRequests = body.maxRequests ?? 500;
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > 10000 || typeof (body.retryFailed ?? false) !== "boolean") throw failure("Neispravan limit zahtjeva.", 400);
    if (body.resumeId) {
      job = this.read(body.resumeId);
      if (!job.canResume) throw failure("Ovu snimku nije moguće nastaviti. Provjeri izvor ili pokreni novu snimku.");
    } else {
      const root = body.root ?? "", profile = body.profile ?? "catalog";
      if (typeof root !== "string" || root.length > 4096 || /[\0\r\n]/.test(root) || !["full", "catalog"].includes(profile)) throw failure("Neispravna grana ili profil skeniranja.", 400);
      job = { id: randomUUID(), root, profile, createdAt: new Date().toISOString(), source: this.source() };
      fs.mkdirSync(this.jobPath(job.id), { recursive: true, mode: 0o700 });
    }
    job.state = "starting"; job.message = "Čekam završetak postojećih očitanja."; job.canResume = false; job.requests = 0; job.maxRequests = maxRequests;
    // Prior exports remain on disk, but must not masquerade as current results
    // if a resumed run fails before exporting/indexing its new checkpoint.
    job.exportsReady = false;
    delete job.catalog;
    this.save(job);
    const active = { job, stop: false, child: null, release: null };
    this.active = active;
    active.done = this.execute(active, Boolean(body.resumeId), body.retryFailed === true);
    this.notify();
    return this.publicJob(job);
  }
  async execute(active, resume, retryFailed) {
    const { job } = active;
    try {
      active.release = await this.poller.holdForCatalogScan();
      if (active.stop || this.closing) { job.state = "paused"; job.message = "Skeniranje je zaustavljeno prije prvog zahtjeva."; return; }
      job.state = "running"; job.message = "Čitam strukturu zgrade."; this.save(job); this.notify();
      const exit = await new Promise((resolve, reject) => {
        const child = this.spawnImpl(this.python, ["-u", this.script], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: workerEnvironment() });
        active.child = child;
        let buffer = "", reportedFailure = false, finished = false;
        child.stdin.on("error", () => {});
        child.on("error", () => reject(failure("Python mapper nije pokrenut. Provjeri instalaciju Pythona i DASHBOARD_SCAN_PYTHON.", 500)));
        child.stdout.on("data", chunk => {
          buffer += chunk.toString("utf8");
          if (buffer.length > 1024 * 1024) { buffer = ""; return; }
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try {
              const event = JSON.parse(line);
              if (event.event === "progress" || event.event === "finished") {
                job.summary = event.summary;
                if (event.requests !== undefined) job.requests = event.requests;
                if (event.event === "finished") { finished = true; job.exportsReady = true; }
              } else if (event.event === "failed") reportedFailure = true;
              this.save(job); this.notify();
            } catch { /* Mapper's human-readable stdout is not an API or log. */ }
          }
        });
        child.on("close", code => resolve({ code, reportedFailure, finished }));
        // Credentials only cross a private stdin pipe, never CLI args, browser
        // responses, persisted jobs or worker environment variables.
        child.stdin.write(JSON.stringify({ output: this.jobPath(job.id), url: this.config.middlewareUrl,
          username: this.config.username, password: this.config.password, root: job.root, profile: job.profile,
          resume, retryFailed, maxRequests: job.maxRequests, timeout: Math.max(20, (this.config.timeoutMs || 10000) / 1000 + 5), delay: this.delay,
          ...(this.caFile && { caFile: this.caFile }) }) + "\n");
        if (active.stop) child.stdin.end("stop\n");
      });
      if (job.summary?.pages) {
        job.state = "indexing"; job.message = "Spremam prepoznate uređaje u katalog."; this.save(job); this.notify();
        job.catalog = await this.workerImpl({ operation: "import", checkpoint: path.join(this.jobPath(job.id), "checkpoint.sqlite"), database: path.join(this.jobPath(job.id), "catalog.sqlite") });
      }
      if (exit.reportedFailure || !exit.finished || ![0, 2, 130].includes(exit.code)) {
        job.state = "failed"; job.message = "Skeniranje nije završeno. Provjeri vezu, vjerodajnice i zauzetost mappera. Spremljene stranice ostaju sačuvane.";
      } else if (active.stop || exit.code === 130 || job.summary?.states?.pending) {
        job.state = "paused"; job.message = "Napredak je spremljen. Nastavi kada želiš.";
      } else if (job.summary?.states?.error || job.summary?.states?.partial || job.summary?.states?.unknown) {
        job.state = "partial"; job.message = "Obilazak je završio s greškama ili nepotvrđenom potpunosti. Provjeri sažetak prije korištenja.";
      } else {
        job.state = "completed"; job.message = job.profile === "catalog" ? "Obilazak kataloga je završen; isključene tehničke grane nisu skenirane." : "Obilazak dostupne strukture je završen.";
      }
    } catch (error) {
      job.state = "failed"; job.message = error.code === "CATALOG_SCAN_UNAVAILABLE" ? error.message : "Skeniranje ili spremanje kataloga nije uspjelo. Prethodni checkpoint ostaje sačuvan.";
    } finally {
      job.canResume = job.state !== "completed" && fs.existsSync(path.join(this.jobPath(job.id), "checkpoint.sqlite"));
      try { this.save(job); } catch { job.message = "Status nije moguće spremiti. Provjeri slobodan prostor i ovlasti direktorija."; }
      if (this.active === active) this.active = null;
      active.release?.(!this.closing);
      this.notify();
    }
  }
  pause(id) {
    if (!this.active || this.active.job.id !== id) throw failure("Skeniranje nije aktivno.");
    if (this.active.job.state === "indexing") throw failure("Pričekaj dovršetak spremanja kataloga.");
    this.active.stop = true;
    this.active.job.state = "stopping"; this.active.job.message = "Čekam završetak aktivnog zahtjeva i spremam napredak.";
    if (this.active.child && !this.active.child.stdin.writableEnded) this.active.child.stdin.end("stop\n");
    this.save(this.active.job); this.notify();
    return this.publicJob(this.active.job);
  }
  async devices(id, search = "", offset = 0) {
    const job = this.read(id);
    if (this.active?.job.id === id || !job.catalog) throw failure("Katalog za ovu snimku još nije spremljen.");
    if (typeof search !== "string" || search.length > 200 || !Number.isSafeInteger(offset) || offset < 0) throw failure("Neispravna pretraga kataloga.", 400);
    return this.workerImpl({ operation: "devices", database: path.join(this.jobPath(id), "catalog.sqlite"), search, offset });
  }
  download(id, filename) {
    const job = this.publicJob(this.read(id));
    if (!job.files.includes(filename)) throw failure("Datoteka nije dostupna.", 404);
    return path.join(this.jobPath(id), filename);
  }
  async shutdown() {
    this.closing = true;
    const active = this.active;
    if (!active) return;
    active.stop = true;
    if (active.child && !active.child.stdin.writableEnded) active.child.stdin.end("stop\n");
    await active.done;
  }
}

module.exports = { BuildingScan };
