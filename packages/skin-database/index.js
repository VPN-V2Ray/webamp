const express = require("express");
const app = express();
const config = require("./config");
const Skins = require("./data/skins");
const port = process.env.PORT ? Number(process.env.PORT) : 3001;
const fileUpload = require("express-fileupload");
const { addSkinFromBuffer } = require("./addSkin");
const Discord = require("discord.js");
const Utils = require("./discord-bot/utils");
const cors = require("cors");
var bodyParser = require("body-parser");
var LRU = require("lru-cache");

const allowList = [
  /https:\/\/skins\.webamp\.org/,
  /http:\/\/localhost:3000/,
  /netlify.app/,
];
const corsOptions = {
  origin: function (origin, callback) {
    if (allowList.some((regex) => regex.test(origin)) || !origin) {
      callback(null, true);
    } else {
      callback(
        new Error(`Request from origin "${origin}" not allowed by CORS.`)
      );
    }
  },
};

// parse application/json
app.use(bodyParser.json());

app.use(cors(corsOptions));

app.options("*", cors(corsOptions));

// TODO: Look into 766c4fad9088037ab4839b18292be8b1
// Has huge number of filenames in info.json

app.set("json spaces", 2);
app.use(
  fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 },
  })
);

let skinCount = null;

const options = {
  max: 100,
  maxAge: 1000 * 60 * 60,
};

const cache = new LRU(options);

app.get("/skins/", async (req, res) => {
  if (skinCount == null) {
    skinCount = await Skins.getClassicSkinCount();
  }
  const { offset = 0, first = 100 } = req.query;
  const key = req.originalUrl;
  const cached = cache.get(key);
  if (cached != null) {
    console.log(`Cache hit for ${key}`);
    res.json({ skinCount, skins: cached });
    return;
  }
  console.log(`Getting offset: ${offset}, first: ${first}`);

  const start = Date.now();
  const skins = await Skins.getMuseumPageSql({
    offset: Number(offset),
    first: Number(first),
  });
  console.log(`Query took ${(Date.now() - start) / 1000}`);
  console.log(`Cache set for ${key}`);
  cache.set(key, skins);
  res.json({ skinCount, skins });
});

app.post("/skins/missing", async (req, res) => {
  console.log("Checking for missing skins.");
  const missing = [];
  const found = [];
  for (const md5 of req.body.hashes) {
    if (!(await Skins.skinExists(md5))) {
      missing.push(md5);
    } else {
      found.push(md5);
    }
  }
  console.log(
    `${found.length} skins are found and ${missing.length} are missing.`
  );
  res.json({ missing, found });
});

app.post("/skins/", async (req, res) => {
  const client = new Discord.Client();
  await client.login(config.discordToken);
  const dest = client.channels.get(config.SKIN_UPLOADS_CHANNEL_ID);

  const files = req.files;
  if (files == null) {
    dest.send("Someone hit the upload endpoint with no files attached.");
    res.status(500).send({ error: "No file supplied" });
    return;
  }
  const upload = req.files.skin;
  if (upload == null) {
    dest.send("Someone hit the upload endpoint with no files attached.");
    res.status(500).send({ error: "No file supplied" });
    return;
  }
  let result;

  try {
    result = await addSkinFromBuffer(upload.data, upload.name, "Web API");
  } catch (e) {
    console.error(e);
    dest.send(`Encountered an error uploading a skin: ${e.message}`);
    res.status(500).send({ error: `Error adding skin: ${e.message}` });
    return;
  }

  if (result.status === "ADDED") {
    // await new Promise((resolve) => setTimeout(resolve, 3000));
    if (result.skinType === "CLASSIC") {
      console.log(`Going to post new skin to discord: ${result.md5}`);
      // Don't await
      Utils.postSkin({
        md5: result.md5,
        title: (filename) => `New skin uploaded: ${filename}`,
        dest,
      });
    } else if (result.skinType === "MODERN") {
      dest.send(
        `Someone uploaded a new modern skin: ${upload.name} (${result.md5})`
      );
    }
  }

  res.json({ ...result, filename: upload.name });
});

app.get("/skins/:md5", async (req, res) => {
  const { md5 } = req.params;
  console.log(`Details for hash "${md5}"`);
  const skin = await Skins.getSkinByMd5_DEPRECATED(md5);
  if (skin == null) {
    res.status(404).json();
    return;
  }
  res.json(skin);
});

app.post("/skins/:md5/index", async (req, res) => {
  const { md5 } = req.params;
  console.log(`Going to index hash "${md5}"`);
  const skin = await Skins.updateSearchIndex(md5);
  res.json(skin);
});

// TODO: Make this POST
app.post("/skins/:md5/report", async (req, res) => {
  const { md5 } = req.params;
  console.log(`Reporting skin with hash "${md5}"`);
  const client = new Discord.Client();
  await client.login(config.discordToken);
  const dest = client.channels.get(config.NSFW_SKIN_CHANNEL_ID);

  const skin = await Skins.getSkinByMd5_DEPRECATED(md5);

  if (skin.tweetStatus === "UNREVIEWED") {
    // Don't await
    Utils.postSkin({
      md5,
      title: (filename) => `Review: ${filename}`,
      dest,
    });
  } else {
    Utils.sendAlreadyReviewed({ md5, dest });
  }

  res.send("The skin has been reported and will be reviewed shortly.");
});

app.get("/skins/:md5/screenshot.png", async (req, res) => {
  const { md5 } = req.params;
  console.log(`Getting screenshot for hash "${md5}"`);
  const { screenshotUrl } = await Skins.getSkinByMd5_DEPRECATED(md5);
  if (screenshotUrl == null) {
    res.status(404).send();
    return;
  }
  res.redirect(301, screenshotUrl);
});

app.get("/skins/:md5/download", async (req, res) => {
  const { md5 } = req.params;
  console.log(`Downloading for hash "${md5}"`);
  const { skinUrl } = await Skins.getSkinByMd5_DEPRECATED(md5);
  if (skinUrl == null) {
    res.status(404).send();
    return;
  }
  res.redirect(301, skinUrl);
});

app.use(function (err, req, res, next) {
  console.error(err.stack);
  res.status(500).send("Oops. Something went wrong. We're working on it.");
});

app.listen(port, () => console.log(`Example app listening on port ${port}!`));
