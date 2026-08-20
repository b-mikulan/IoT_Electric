# KNX project extractor

This development utility extracts XML files from a `.knxproj` archive and creates a JSON summary of device settings.

Run it from the repository root:

```sh
npm run knx:extract -- path/to/project.knxproj
```

The default destination is the ignored root `output/` folder. An alternative output parent can be supplied as the second argument:

```sh
npm run knx:extract -- path/to/project.knxproj path/to/output
```

The source archive is required; the utility no longer assumes a personal project filename. It creates `<project>_extracted/` and `<project>_settings.json` inside the selected output folder. Existing output is not deleted first, so remove stale generated data manually when a completely clean extraction is needed.