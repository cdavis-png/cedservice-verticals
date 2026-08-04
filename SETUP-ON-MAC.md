# Setup on the Mac Mini

Do not create the folders manually on your phone.

## Steps

1. Download `cedservice-verticals-bootstrap.zip` to the Mac Mini.
2. Double-click the ZIP to extract it.
3. Open **Terminal**.
4. Type `cd ` with a space after it.
5. Drag the extracted `cedservice-verticals-bootstrap` folder into the Terminal window.
6. Press Return.
7. Run:

```bash
bash install-on-mac.sh
```

The installer will:

- Clone `cdavis-png/cedservice-verticals`
- Create the full repository structure
- Add the current nail-salon website
- Commit the changes
- Push them to GitHub

GitHub may open a browser sign-in the first time Git needs authorization.

## After installation

The main nail-salon prototype will be located at:

`verticals/beauty-wellness-fitness/nails/site/`

The local repository will be located at:

`~/cedservice-verticals`
