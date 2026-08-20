# EWS sandbox

These scripts are manual experiments for inspecting and troubleshooting an EcoStruxure EWS controller. They are not imported by the middleware, included in its Docker image, or run by the automated tests.

They use the repository's Node.js dependencies and controller settings from `EWS_URL`, `EWS_USER`, and `EWS_PASSWORD`. Node does not load the root `.env` automatically for these scripts, so opt in explicitly:

```sh
node --env-file=.env tools/ews-sandbox/test-soap.js describe
```

`test-soap.js` also accepts `basic`, `wsse-text`, `wsse-digest`, or `none` as its final mode argument. Review every script before running it: all current experiments disable TLS certificate verification, and that test-only bypass must never be copied into production code. In particular, `postavljanje_test.js` sends a real value write to its hard-coded test point.
