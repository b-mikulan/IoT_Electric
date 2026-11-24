# Priprema nove instance na serveru

Za postojeći Linux server s Dockerom i Portainerom (Docker Standalone).
Skripta priprema foldere i datoteke; stack zatim deployaš u Portaineru kao dosad.

Za novi Portainer stack skripta više nije potrebna: Portainer može deployati
`docker-compose.portainer.yml` izravno iz repozitorija, a middleware vjerodajnice
i konfiguracijski volume slože se pri prvom pokretanju. Upute su u glavnom
[README.md](../../README.md#new-portainer-stack). Skripta ostaje za instance koje
se pokreću Docker Compose CLI-jem na serveru ili za koje želiš unaprijed
generirane vjerodajnice u datotekama.
Radi iz bilo kojeg radnog foldera, a izvornu konfiguraciju uzima iz ovog repozitorija.
Ne instalira Docker/Portainer i ne mijenja postojeće stackove ili firewall.

## Pokretanje

Na serveru, iz foldera repozitorija (u postojećoj instalaciji `/opt/iot-electric`):

```bash
sudo bash tools/stack-setup/prepare-instance.sh \
  --name cnus \
  --image-tag 0.5.0 \
  --middleware-port 3100 \
  --dashboard-port 3101 \
  --ews-url 'https://cnus.iot-electric.hr:60588/EcoStruxure/DataExchange' \
  --ews-user 'KORISNIK_NOVOG_EWS_SERVERA'   --admin-user admin
```

Skripta će pitati za **EWS lozinku** (unos se ne prikazuje).
Puni EWS endpoint treba odgovarati novom serveru; skripta ga ne otkriva automatski.
URL putanja u primjeru nije potvrda da novi kontroler koristi baš tu putanju.

`--image-tag` treba biti verzija koja je već objavljena za oba GHCR imagea, bez `v`.
Nemoj pretpostaviti da je `latest` objavljen: trenutačni workflow objavljuje slike na push verzijskog taga.
`0.5.0` je primjer; upiši verziju koju želiš deployati.

Početne vrijednosti nisu potrebne. Bez dodatnih opcija skripta zapisuje prazan
`widgets.json` (`[]`), dashboard kreće bez vrijednosti, a nakon deploya ih dodaješ
kroz discovery na dashboardu.

Ako već imaš konfiguraciju widgeta, dodaj:

```bash
--widgets /putanja/do/widgets.json
```

Tada skripta kopira i provjerava tvoju datoteku, koja zadržava svoje postavke.
Za brzu provjeru EWS veze možeš umjesto toga zadati jednu stvarnu vrijednost s
`--point-id '01/ES/Building/Temperature'`; taj widget ima `writable: false`.
Datoteka služi samo za prvo pokretanje; nakon toga konfiguracija je u bazi.

`--admin-user` zadaje administratora dashboarda (zadano `admin`). Skripta mu
generira lozinku i upisuje oba podatka u `.env` i `portainer.env` kao
`DASHBOARD_ADMIN_USER` i `DASHBOARD_ADMIN_PASSWORD`.

Shell skripta koristi Node >=24 ako je instaliran. Inače pokrene kratkotrajni
`node:24-alpine` container i ukloni ga nakon pripreme. Ne treba `npm install`.
Za prvi takav poziv Docker mora moći povući Node image. Pokreće se sa `sudo` radi prava nad folderima.

## Rezultat

```text
/opt/iot-electric/cnus/
├── dashboard-config/
│   └── widgets.json
├── docker-compose.yml
├── .env
├── portainer.env
├── .gitignore
└── DEPLOY.txt
```

- Svaka instanca ima vlastiti folder, middleware korisnika i novu nasumičnu lozinku.
- Middleware dobiva scrypt hash, a dashboard odgovarajuću običnu lozinku.
- Administrator dashboarda dobiva vlastitu nasumičnu lozinku.
- `dashboard-config` pripada UID/GID `1000:1000`, s pravima `750`; widget datoteka ima `640`.
  To omogućuje spremanje kroz discovery i uređivanje widgeta u dashboardu.
- `.env`, `portainer.env`, Compose i upute imaju prava `600`; lozinke se ne ispisuju.
- Generirani folder ima vlastiti `.gitignore` koji izuzima sve njegove datoteke.
- Ako naziv instance već postoji, skripta odbija pripremu bez promjene postojećih datoteka.
- Portovi moraju biti različiti. Provjeravaju se druge ovako pripremljene instance
  te portovi koji slušaju na serveru ili su objavljeni kroz Docker.
  Konačnu provjeru zauzetosti portova radi i Docker pri deployu.
- `--base-dir /druga/putanja` mijenja osnovni folder i automatski postavlja mount za dashboard.

Portovi `3100` i `3101` su primjer za drugu instancu uz postojeću na `3000`/`3001`.
Svaki novi stack treba dva slobodna vanjska porta; unutarnji ostaju `3000`/`3001`.
Na GCP-u za nove portove posebno prilagodi postojeće firewall pravilo za iste dopuštene IP adrese.

## Deploy u Portaineru

Prenesi `docker-compose.yml` i `portainer.env` iz generiranog foldera na računalo
s kojeg otvaraš Portainer, primjerice privatnim SFTP pristupom. Widgeti ostaju na Docker serveru.

1. **Stacks → Add stack**, naziv jednak `--name` (npr. `cnus`).
2. **Upload** generiranog `docker-compose.yml` ili zalijepi ga u **Web editor**.
3. **Load variables from .env file** → učitaj **`portainer.env`**.
4. Provjeri verziju, portove i EWS URL pa **Deploy the stack**.

`portainer.env` koristi obične vrijednosti za Portainerov importer.
`.env` koristi navodnike za Docker Compose CLI, kako posebni znakovi u lozinkama
ne bi pokrenuli interpolaciju. Ta dva izlaza služe različitim načinima učitavanja.
Izvori: [Portainer stack setup](https://docs.portainer.io/sts/user/docker/stacks/add),
[Portainer importer](https://github.com/portainer/portainer/blob/develop/app/react/components/form-components/EnvironmentVariablesFieldset/utils.ts),
[Compose .env pravila](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

Ako su GHCR imagei privatni, koristi već podešen GHCR registry u Portaineru.
Skripta ne provjerava dostupnost image taga i EWS vezu. Za kontroler s drugim CA-om
ili samopotpisanim certifikatom dodaj u stack `EWS_CA_CERT` (PEM ili PEM kodiran u base64).

Za API/Swagger login pročitaj `MIDDLEWARE_USER` i `DASHBOARD_MIDDLEWARE_PASSWORD` iz `.env`.
Za prijavu u dashboard pročitaj `DASHBOARD_ADMIN_USER` i `DASHBOARD_ADMIN_PASSWORD` iz `.env`.
Administrator ne postoji u bazi, nego samo kroz te varijable stacka. Zato ih ne briši
nakon prvog pokretanja: bez njih se na dashboard ne može prijaviti nitko dok
administrator ne doda druge korisnike. Novu lozinku postavljaš promjenom
`DASHBOARD_ADMIN_PASSWORD` u Portaineru i updateom stacka. Ostale korisnike
dodaje administrator kroz **Admin** u dashboardu.

Ako se dashboardu pristupa preko HTTPS-a, u Portaineru dodaj `DASHBOARD_SECURE_COOKIES=true`.
Iza reverse proxyja dodaj i `DASHBOARD_TRUST_PROXY=1` i `MIDDLEWARE_TRUST_PROXY=1`
(broj proxyja ispred servisa). Skripta te varijable ne postavlja.
`DEPLOY.txt` sadrži upute prilagođene pripremljenoj instanci.
Nakon deploya provjeri `/health`, stvarni read-only API poziv i dashboard `/ready`.

Za kasniju promjenu image verzije ili EWS postavki uredi varijable postojećeg
stacka u Portaineru i napravi update. Lokalni `.env` ne ažurira Portainer automatski.

## Priprema bez interaktivnih pitanja

Privatna JSON datoteka može sadržavati `url`, `username` i `password`:

```json
{
  "url": "https://controller.example/EcoStruxure/DataExchange",
  "username": "ews-user",
  "password": "EWS_LOZINKA"
}
```

Čuvaj je izvan Gita s pravima `600`, zatim:

```bash
sudo bash tools/stack-setup/prepare-instance.sh \
  --name cnus --image-tag 0.5.0 \
  --middleware-port 3100 --dashboard-port 3101 \
  --connection-file /privatna/putanja/connection.json \
  --widgets /privatna/putanja/widgets.json
```

Za sve opcije koristi `bash tools/stack-setup/prepare-instance.sh --help`.
