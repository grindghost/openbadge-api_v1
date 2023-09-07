const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
// const serviceAccount = require("./cert/backpacks3-firebase-adminsdk-fb8nm-f264f57da4.json");

const bakery = require('openbadges-bakery'); 
// Patched version from OpenWorksGroup to fix a bug with the badge image...
// https://github.com/OpenWorksGroup/openbadges-bakery/

const axios = require('axios');
require('dotenv').config()
// Reference to load firebase admin credentials from environment variables
// https://www.benmvp.com/blog/initializing-firebase-admin-node-sdk-env-vars/

const puppeteer = require('puppeteer');

const { PDFDocument, PDFName } = require('pdf-lib');
const fetch = require('node-fetch');

// Node-mailer
const SendEmail = require('./services/email');

const DEV_PREFIX = 'dev';

// Initialize Firebase admin by providing your service account credentials from JSON file
/*
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://backpacks3-default-rtdb.firebaseio.com"
});
*/

admin.initializeApp({
    credential: admin.credential.cert({
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: "https://backpacks3-default-rtdb.firebaseio.com"
  })

// Initialize Express app
const app = express();

// Enable CORS
app.use(cors());

// Enable JSON body parsing
app.use(express.json());

app.post('/api/createBadgeAssertion', async (req, res) => {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authorization header must be provided and formatted as \'Bearer <token>\'' });
    }
    const token = req.header('Authorization').split('Bearer ')[1];
    
    let uid;
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        uid = decodedToken.uid;
    } catch (error) {
        return res.status(401).send({ error: 'You must be logged in to earn a badge.' });
    }

    const db = admin.database();

    const configsRef = db.ref(`configs`);
    const configsSnapshot = await configsRef.once('value');
    const configsData = configsSnapshot.val();

    const userRef = db.ref(`users/${uid}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();

    const projectRef = db.ref(`projects/${req.body.projectId}`);
    const projectSnapshot = await projectRef.once('value');
    const projectData = projectSnapshot.val();
    console.log(projectData);
    console.log('👽', puppeteer.executablePath())

    // Get the targeted badge and course
    const badgeId = projectData.badgeClass;
    const courseId = projectData.course;
    
    const badgeRef = db.ref(`badges/${badgeId}`);
    const badgeSnapshot = await badgeRef.once('value');
    const badgeData = badgeSnapshot.val();

    // If user already has the badge, return an error
    if (userData.badges && userData.badges[badgeId]) {

        // Get the assertion ID for the current badge
        const assertionId = userData.badges[badgeId].assertionId;
        
        // Get the assertion details
        const assertionRef = db.ref(`assertions/${assertionId}`);
        const assertionSnapshot = await assertionRef.once('value');
        const assertionData = assertionSnapshot.val(); 


        // Check if the assertion has been revoked for being expired...        
        // Get the current date...
        const now = new Date();

        // Get the revoked status and reason
        // Get the revocation details (1st read)
        let revokedData = await getRevocationDetails(assertionId);

        // Check if the assertion has expiration date
        if ('expires' in assertionData) {

          // Check if the assertion is expired
          if (now > new Date(assertionData.expires)) {

            // Update the revocation status, only if not already revoked...
            if (assertionData.revoked == false) {
              
              // Revoke the assertion in the revocation list for reason of being expired
              await db.ref(`revoked/${assertionId}`).set({ 
                revokedStatus: true, 
                reason: "expired",
              });

              // Update the revoked key in the assertion
              await db.ref(`assertions/${assertionId}/revoked`).set(true);
              
              // return res.status(403).json({ error: 'This badge has been revoked', assertion: assertionData, badgeImageUrl: badgeData.image });

            }

          } else {

            // Allow revocation status rectification...
            if (assertionData.revoked == true) {

              if (revokedData.reason == 'expired') {
                
                // Correct the revocation status
                await db.ref(`revoked/${assertionId}`).set({ 
                  revokedStatus: false, 
                  reason: "placeholder"
                });

                // Update the revoked key in the assertion
                await db.ref(`assertions/${assertionId}/revoked`).set(false);
              }
            }
          }
        }

        // Get the revocation details (2nd read)
        revokedData = await getRevocationDetails(assertionId);

        // Check if the assertion has been revoked for other reasons...
        if (revokedData.revokedStatus == true) {

          // Revoke the badge in the assertion
          await db.ref(`assertions/${assertionId}/revoked`).set(true);

          // Get the revocation details (3rd read)
          revokedData = await getRevocationDetails(assertionId);

          assertionData['revocationDetails'] = revokedData;
          

          return res.status(403).json({ error: 'This badge has been revoked', assertion: assertionData, badgeImageUrl: badgeData.image });
        }

        // Else, return the assertion data (and make sure the assertion is not revoked)  
        await db.ref(`assertions/${assertionId}/revoked`).set(false);

        return res.status(409).json({ error: 'User already has the badge', assertion: assertionData, badgeImageUrl: badgeData.image });
    }

    // Get the issuedOn date
    const timestamp = Date.now();
    const date = new Date(timestamp);
    const issuedOn = date.toISOString();

    // Calculate the expiration date if validity is defined and is an integer
    let expires = null;
    if (projectData.periodOfValidity) {
        expires = new Date(date); // Clone the date object
        expires.setDate(date.getDate() + projectData.periodOfValidity); // Use the date object here
        expires = expires.toISOString(); // Convert to ISO string format
    }
        
    // Create a new assertion
    const newAssertion = {
        "@context": "https://w3id.org/openbadges/v2",
        "type": "Assertion",
        "uid": DEV_PREFIX + db.ref('assertions').push().key, // Creates a new key but does not send data
        "recipient": {
            "identity": userData.email,
            "type": "email",
            "hashed": false
        },
        "issuedOn": issuedOn,
        "badge": `https://backpacks3-default-rtdb.firebaseio.com/badges/${badgeId}.json`,
        "verify": {
            "type": "hosted",
            "url": "placeholder"
        },
        "revoked": false,
        "extensions:recipientProfile": {
          "name": userData.name,
          "@context": "https://openbadgespec.org/extensions/recipientProfile/context.json",
          "type": [
            "Extension",
            "extensions:RecipientProfile"
          ]
        },
        "course": courseId,
        "project": req.body.projectId,
        "points": projectData.points,
    }

    newAssertion.verify.url = `https://backpacks3-default-rtdb.firebaseio.com/assertions/${newAssertion.uid}.json`; // set to correct value

    // Conditionally add the expires field if it was calculated
    if (expires) {
        newAssertion.expires = expires;
    }

    // Write the new assertion to the assertions path
    const assertionRef = db.ref(`assertions/${newAssertion.uid}`);
    await assertionRef.set(newAssertion);
    const assertionSnapshot = await assertionRef.once('value');
    const assertionData = assertionSnapshot.val();    

    // Add the assertion to the revoked path... (for testing purposes)
    // const revokedRef = db.ref(`revoked/${newAssertion.uid}`);
    // await revokedRef.set(newAssertion);

    // Add the assertion to the revocation list
    // 💡 Maybe add {reason: explanation...}

    // { revokedStatus: false, reason: "placeholder" }
    await db.ref(`revoked/${newAssertion.uid}`).set({
      revokedStatus: false,
      reason: "placeholder"
    });

    // Update user's badges
    const userBadgeData = { assertionId: newAssertion.uid, timestamp };
    await db.ref(`users/${uid}/badges/${badgeId}`).set(userBadgeData);

    // Update user's backpack points
    const currentPoints = userData.points || 0;
    const userPointsData = currentPoints + projectData.points;
    await db.ref(`users/${uid}/points/`).set(userPointsData);

    // Create a new history event
    if (configsData.history == true) {
        const newEvent = {
            "type": "Open Badge assertion",
            "assertion": newAssertion.uid,
            "course": courseId,
            "badgeClass": badgeId,
            "users": uid,
            "email": userData.email,
            "timestamps": timestamp
        }   
        const historyRef = db.ref('history').push(newEvent);
    }

        // Send confirmation email
        // Create the url to download the backpack in the email
        /*
        const download_backpack_url = `${process.env.BASE_API_URL}api/downloadBackpackFromEmail?token=${token}`;

        SendEmail(userData.email, badgeData.image, badgeData.name, download_backpack_url, userData.name);
        */

    res.json({ message: 'Badge earned successfully', badge: badgeData, assertion: assertionData, badgeImageUrl: badgeData.image  });
});


// ****************************************


app.get('/api/bakeBadge', async (req, res) => {
  console.log("bakeBadge route called");
  const emissionData = JSON.parse(req.query.emissionData);
  const badgeImageUrl = req.query.imageUrl;

  console.log(emissionData)

  try {
    console.log("Attempting to fetch image from:", badgeImageUrl);
    const { data } = await axios.get(badgeImageUrl, { responseType: 'arraybuffer' });
    console.log("Image fetched successfully");

    try {
      console.log("Attempting to add metadata to image");
      const bufferData = Buffer.from(data);

      bakery.bake({ image: bufferData, assertion: emissionData }, function (err, baked) {
        if (err) {
          console.error("Error modifying image:", err);
          res.status(500).json({ error: 'Error modifying image' });
          return;
        }

        console.log("Metadata added successfully");
        console.log("Attempting to send modified image");
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', 'attachment; filename=badge.png');
        res.end(baked);
        console.log("Modified image sent successfully");
      });
      
    } catch (modificationError) {
      console.error("Error modifying image:", modificationError);
      res.status(500).json({ error: 'Error modifying image' });
    }
    
  } catch (fetchError) {
    console.error("Error fetching image:", fetchError);
    res.status(500).json({ error: 'Error fetching image' });
  }
});

// ****************************************

async function getRevocationDetails(assertionId) {
  const db = admin.database();

  // Get the revocation details
  const revokedRef = db.ref(`revoked/${assertionId}`);
  const revokedSnapshot = await revokedRef.once('value');
  const revokedData = revokedSnapshot.val();

  return revokedData;

}


async function getUserName(userId) {
  const db = admin.database();

  // Get the user name
  const userRef = db.ref(`users/${userId}/name`);
  const userSnapshot = await userRef.once('value');
  const userName = userSnapshot.val();

  // Get the user points
  const userPointsRef = db.ref(`users/${userId}/points`);
  const userPointsSnapshot = await userPointsRef.once('value');
  const userPoints = userPointsSnapshot.val();

  return [userName, userPoints];

}

async function getAllBadgesForUser(userId) {

  const db = admin.database();

  const userBadgesBackpack = []
  const userBadgesData = await db.ref(`users/${userId}/badges`).once('value');

  for (const [key, value] of Object.entries(userBadgesData.val())) {

    // Get the badge image
    const badgeImageRef = db.ref(`badges/${key}`);
    const badgeImageSnapshot = await badgeImageRef.once('value');
    const badgeImageData = badgeImageSnapshot.val();

    // Get the assertions details
    const assertionRef = db.ref(`assertions/${value.assertionId}`);
    const assertionSnapshot = await assertionRef.once('value');
    const assertionData = assertionSnapshot.val();

    const revokedDetails = await RetrieveAndUpdateRevocationDetails(assertionData)

    userBadgesBackpack.push({
      name: badgeImageData.name,
      imageUrl: badgeImageData.image,
      assertion: assertionData,
      revoked: revokedDetails.revokedStatus,
      revokedReason: revokedDetails.reason
    });

    }
    return userBadgesBackpack;
}

const bakeBadge = async (emissionData, badgeImageUrl) => {
  try {
    const { data } = await axios.get(badgeImageUrl, { responseType: 'arraybuffer' });
    const bufferData = Buffer.from(data);

    return new Promise((resolve, reject) => {
      bakery.bake({ image: bufferData, assertion: emissionData }, function (err, baked) {
        if (err) {
          reject(err);
        }
        resolve(baked);
      });
    });
  } catch (error) {
    throw error;
  }
};

const generateHtmlGrid = (badges, username, user_points) => {

    // Create a placeholder badge for empty spots
    const placeholderBadge = {
      imageUrl: 'https://www.dropbox.com/scl/fi/pmo6iis7kfgsk90k2thez/empty.png?rlkey=c74t66op8q62y1s5ypxm5u1na&raw=true',
      isPlaceholder: true
  };

  // Fill the grid with placeholder badges until there's a total of 9
  while (badges.length % 9 !== 0) {
      badges.push(placeholderBadge);
  }

  // Create a timestamp
  const timestamp = Date.now();
  const date = new Date(timestamp);
  const downloadedOn = date.toISOString();

  const downloadedOnFrenchDate = _formatDateToFrench(downloadedOn);

  const pages = [];
  for (let i = 0; i < badges.length; i += 9) {
      const pageContent = `

  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title></title>

    <style>

    @import url('https://fonts.googleapis.com/css2?family=Overpass:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&family=Source+Sans+3:ital,wght@0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=swap');
    * {
      box-sizing: border-box;
    }

      body {
        font-family: 'Overpass', sans-serif;
        display: flex;               /* Enable Flex */
        flex-direction: column;     /* Stack children vertically */
        height: 100vh;              /* Take up the full viewport height */
        margin: 0;                  /* Remove default margin */
    }
    
    
    .header {
      align-items: center;
      background-color: white;
      border-bottom: 6px solid #f0f2f5;
      width: auto;             /* Fixed height for header/footer */
      height: auto;
    }

    .header img {
      width: 100%;
  }

    .header-username {
      position: absolute;
      z-index: 10;
      font-family: 'Source Sans 3';
      font-size: 18px;
      font-weight: 600;
      text-align: right;
      line-height: 100%;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      width: 100%;
      height: 150px;
      right: 40px;
  }

  .version {
      font-size: 14px;
      font-weight: 400;
  }

  .points {
      display: flex;
      justify-content: center;
      align-items: center;
      text-align: center;
      background-color: #f0f2f5;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      padding: 30px;
      margin-left: 20px;
    }

  .footer {
      background-color: #f0f2f5;
      padding: 20px;
      margin: 30px;
      border-radius: 5px;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Source Sans 3';
      font-size: 12px;
      height: 60px;               /* Fixed height for header/footer */
  }
    
  .grid {
    display: grid;
    grid-auto-rows: 1fr; 
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    padding: 32px 36px 10px 36px; ;
/*     max-width: 90%;
    margin: 0 auto; */
    flex: 1;                    /* Expand to take up available space */
    overflow-y: auto;           /* Add scrollbar if content exceeds the middle space */
}

  .card {
      border: 1px solid #e0e0e0;
      padding: 15px;
      border-radius: 5px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      text-align: center;
  }

  .card img {
      max-width: 80px;
      height: auto;
      border-radius: 5px;
      position: relative; 
      margin-top: 10px;
  }

  .card h2 {
      font-size: 18px;
      margin-top: 12px;
  }

  .card p {
      font-family: 'Source Sans 3';
      font-size: 13px;
      margin: 5px 0;
      line-height: 1.0;
      margin-bottom: 8px;
  }

  strong {
    font-weight: 600;  
  }

  .status-band {
  position: absolute;
    width: fit-content;
    top: -4px;  /* Margin from the top */
    left: -4px; /* Margin from the left */
    height: 20px;
    line-height: 20px; 
    color: black;
    font-weight: bold;
    font-size: 13px;
    text-align: left;
    display: inline-block;       /* Ensure the width fits the content */
    padding: 3px 10px 20px 10px;              /* Small horizontal padding to give it some room */
    }

    .point-band {
      position: absolute;
      width: fit-content;
      top: -4px;  /* Margin from the top */
      right: -4px; /* Margin from the left */
      height: 20px;
      line-height: 20px; 
      color: black;
      font-family: 'Source Sans 3';
      font-size: 13px;
      text-align: left;
      display: inline-block;       /* Ensure the width fits the content */
      padding: 3px 10px 20px 10px;    
    
    }


    
  .status-band.revoked {
      background-color: #e10414;
      border-radius: 3px;
      color: white;
  }
  
  .status-band.expired {
      background-color: #fdbf08;
      border-radius: 3px;
      color: white;
  }

        a {
          text-decoration: none;
          color: black;
        }

  
    </style>

    </head>
    
    <body>

    <div class="header">
      <img class="header-img" src="https://www.dropbox.com/scl/fi/6e4bp0s93hdhk7hty4z35/header.svg?rlkey=svvz6xprj30au8yovt9xqs527&raw=true">
    </div>

    <div class="header-username">
        <span class="username">${username}<br>
            <span class="version">${downloadedOnFrenchDate}</span> 
        </span>
        <span class="points">${user_points}pts</span>
    </div>
    
    <div class="grid">
    ${badges.slice(i, i + 9).map(badge => {
        if (badge.isPlaceholder) {
            // Adjust the markup for placeholder badges here
            // Adjust the markup for placeholder badges here
            return `
            <div class="card">
                <img src="${badge.imageUrl}" alt="Placeholder" />
                <div style="height: 15px; width: 100%; background-color: #f0f2f5; margin: 10px 0;"></div>
                <div style="height: 15px; width: 70%; background-color: #f0f2f5; margin: 10px auto;"></div>
                <div style="height: 15px; width: 50%; background-color: #f0f2f5; margin: 10px auto;"></div>
            </div>`;
        } else {
            // Original markup for actual badges with added status band
            /*
            const statusBand = badge.assertion.revoked == true ? 
                               '<div class="status-band revoked">Révoqué</div>' :
                               badge.assertion.revoked == 'expired' ? 
                               '<div class="status-band expired">Expiré</div>' : '';
            */

          console.log('🧙‍♀️', badge)

          const statusBand = badge.revokedReason == 'expired' ? 
                              '<div class="status-band expired">Expiré</div>' :
                              badge.revokedReason != 'placeholder' ? 
                              '<div class="status-band revoked">Révoqué</div>' : '';
                                                          
    
            return `
            <a href="${badge.assertion.verify.url}" target="_blank" alt="assertion">
            <div class="card">
                <div style="position: relative;">  <!-- wrapper for image and status band -->
                    <img src="${badge.imageUrl}" alt="${badge.name}" />
                    ${statusBand}
                    <div class="point-band">${badge.assertion.points} pts</div>
                </div>
                <h2>${badge.name}</h2>
                <p>🎓 <strong>Cours: </strong>${badge.assertion.course}</p>
                <p>🗓 <strong>Date: </strong>${formatDateToFrench(badge.assertion.issuedOn)}</p>
                <p>📦 <strong>UID: </strong> ${badge.assertion.uid}</p>
            </div>
            </a>`;
        }
    }).join('')}
    </div>
    
    <div class="footer">Copyright, 2023, Université Laval.</div>
    </body>
    </html>
  `;
    pages.push(pageContent);
  }
  return pages.join('<div style="page-break-before: always;"></div>');
}

const htmlToPdf = async (html) => {
  const browser = await puppeteer.launch({
    executablePath: '.cache/puppeteer/chrome/mac-116.0.5845.96/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]
  });
  const page = await browser.newPage();
  await page.setContent(html);
  const pdf = await page.pdf({ format: 'letter', printBackground: true });
  await browser.close();
  return pdf;
};

const extractHeaderImage = async (html) => {
  // Step 1: Convert HTML to Image
/*   const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--single-process',
      '--no-zygote',
    ],
    executablePath: process.env.NODE_ENV === 'production' ? process.env.PUPPETEER_EXECUTABLE_PATH : puppeteer.executablePath(),
  }); */
  const browser = await puppeteer.launch({});
  const page = await browser.newPage();
  await page.setContent(html);

/* await page.setViewport({
    width: 1920,
    height: 1080,
    deviceScaleFactor: 2, // Increase the device scale factor to increase the resolution
  }); */

  const elementHandle = await page.$('.header');
  const screenshot = await elementHandle.screenshot();
  await browser.close();
  return screenshot;
};

async function MergePDF(BackpackContentPDFBuffer, username, userid, pngBuffers) {

  // Step 1: Load the first PDF containing the cover and the table of contents
    const PdfUrl = 'https://www.dropbox.com/scl/fi/v21d3l1andv6b8vn0qrjq/backpack.pdf?rlkey=qa2wuud56pomucf7vm4ni2jsf&raw=true';
    
    // Step 2: Load the generated PDF and the second PDF using pdf-lib
    const firstPdfDoc = await PDFDocument.load(BackpackContentPDFBuffer);
    
    const secondPdfBuffer = await fetch(PdfUrl).then(res => res.arrayBuffer());
    const secondPdfDoc = await PDFDocument.load(secondPdfBuffer);

    const pdfDoc = await PDFDocument.create();

    // Copy all pages from the generated PDF and add to new PDF
    const firstPdfPages = await pdfDoc.copyPages(secondPdfDoc, Array.from({ length: secondPdfDoc.getPageCount() }, (_, i) => i));
    for (const page of firstPdfPages) {
        pdfDoc.addPage(page);
    }

    // Copy all pages from the second PDF and add to new PDF
    const secondPdfPages = await pdfDoc.copyPages(firstPdfDoc, Array.from({ length: firstPdfDoc.getPageCount() }, (_, i) => i));
    for (const page of secondPdfPages) {
        pdfDoc.addPage(page);
    }

    // Step 2: Insert header Image into PDF
    /* 
    const image = await pdfDoc.embedPng(header_img);
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];

    // Get the width of the page
    const pageWidth = firstPage.getWidth();

    // Calculate the new height to maintain the aspect ratio
    const aspectRatio = image.height / image.width;
    const newHeight = pageWidth * aspectRatio;

        
    firstPage.drawImage(image, {
      x: 0,
      y: 678, // Adjust the y-coordinate to place the image correctly
      width: pageWidth,
      height: newHeight,
    }); 
    */

    // Add metadata to the merged PDF
    pdfDoc.setTitle(`Mon sac à dos académique | ${username}`);
    pdfDoc.setAuthor('Université Laval');
    pdfDoc.setSubject('Version autoportante de votre sac à dos contenant tous vos badges numériques.');
    pdfDoc.setKeywords([`Nom: ${username}, ID: ${userid}`]);
    pdfDoc.setCreator('Mon sac à dos académiques');
    pdfDoc.setProducer('Université Laval');
    pdfDoc.setLanguage('fr-CA');

    // Viewer preferences
    const viewerPrefs = pdfDoc.catalog.getOrCreateViewerPreferences(); 
    viewerPrefs.setDisplayDocTitle(true);
    viewerPrefs.setCenterWindow(true);
    viewerPrefs.setFitWindow(true);

    // Test to display the attachments panel by default
    pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseAttachments'));

    // Add attachments
    for (const [filename, pngData] of Object.entries(pngBuffers)) {


      // if we need to convert this to ArrayBuffer instead of node Buffer
      // const imgArrayBuffer = bufferToArrayBuffer(pngData);
      
      await pdfDoc.attach(pngData.data, `${filename}`, {
          description: `${pngData.name}`,
          mimeType: 'image/png',
      });
  }

    const updatedPdfBuffer = await pdfDoc.save();
    return updatedPdfBuffer;
  }

  function bufferToArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function formatDateToFrench(isoDate) {
  const date = new Date(isoDate);

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0'); // +1 because months are 0-indexed
  const year = String(date.getFullYear()).slice(-2); // Get the last two digits of the year
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const timePeriod = hours >= 12 ? 'PM' : 'AM';

  return `${day}/${month}/${year} à ${hours}:${minutes}${timePeriod}`;
}

function _formatDateToFrench(isoDate) {
  const monthsInFrench = [
      'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
  ];

  const date = new Date(isoDate);

  const day = date.getDate();
  const month = monthsInFrench[date.getMonth()];
  const year = date.getFullYear();
  const hours = date.getHours();
  const minutes = date.getMinutes();

  // Convert 24-hour format to 12-hour format with AM/PM
  const timePeriod = hours >= 12 ? 'PM' : 'AM';
  const twelveHourFormat = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);

  return `${day} ${month} ${year} à ${twelveHourFormat}:${minutes.toString().padStart(2, '0')} ${timePeriod}`;
}

async function RetrieveAndUpdateRevocationDetails(assertionData) {

  const db = admin.database();

  const assertionId = assertionData.uid;

  // Check if the assertion has been revoked for being expired...        
  // Get the current date...
  const now = new Date();

  // Get the revoked status and reason
  // Get the revocation details (1st read)
  let revokedData = await getRevocationDetails(assertionId);

  // Check if the assertion has expiration date
  if ('expires' in assertionData) {

    // Check if the assertion is expired
    if (now > new Date(assertionData.expires)) {

      // Update the revocation status, only if not already revoked...
      if (assertionData.revoked == false) {
        
        // Revoke the assertion in the revocation list for reason of being expired
        await db.ref(`revoked/${assertionId}`).set({ 
          revokedStatus: true, 
          reason: "expired",
        });

        // Update the revoked key in the assertion
        await db.ref(`assertions/${assertionId}/revoked`).set(true);
        
      }

    } else {

      // Allow revocation status rectification...
      if (assertionData.revoked == true) {

        if (revokedData.reason == 'expired') {
          
          // Correct the revocation status
          await db.ref(`revoked/${assertionId}`).set({ 
            revokedStatus: false, 
            reason: "placeholder"
          });

          // Update the revoked key in the assertion
          await db.ref(`assertions/${assertionId}/revoked`).set(false);
        }
      }
    }
  }

  // Get the revocation details (2nd read)
  revokedData = await getRevocationDetails(assertionId);

  // Check if the assertion has been revoked for other reasons...
  if (revokedData.revokedStatus == true) {

    // Revoke the badge in the assertion
    await db.ref(`assertions/${assertionId}/revoked`).set(true);

    // Get the revocation details (3rd read)
    revokedData = await getRevocationDetails(assertionId);
    return revokedData
  }

  // Else, return the assertion data (and make sure the assertion is not revoked)  
  await db.ref(`assertions/${assertionId}/revoked`).set(false);

  // Get the revocation details (3rd read)
  revokedData = await getRevocationDetails(assertionId);
  return revokedData
}


// ****************************************

app.get('/api/downloadBackpack', async (req, res) => {

  // Make sure the request has a valid Authorization header
  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).send({ error: 'Authorization header must be provided and formatted as \'Bearer <token>\'' });
  }

  const token = req.header('Authorization').split('Bearer ')[1];
  
  let uid;
  try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      uid = decodedToken.uid;
  } catch (error) {
      return res.status(401).send({ error: 'You must be logged in to earn a badge.' });
  }

  // Get the global configs

  // Get the user name
  const userData = await getUserName(uid);
  const userName = userData[0];
  const userPoints = userData[1];

  // Get all badges for the user
  const badges = await getAllBadgesForUser(uid);

  // Bake all badges
  const bakedBadges = {};
  for (const badge of badges) {
    const bakedBadge = await bakeBadge(badge.assertion, badge.imageUrl);
    
    const assertionid = badge.assertion.uid + '.png';
    
    bakedBadges[assertionid] = {
     'data': bakedBadge,
     'name':  badge.name,
     'assertion': badge.assertion
    };    
  }

  const htmlGrid = generateHtmlGrid(badges, userName, userPoints);
  const gridPdf = await htmlToPdf(htmlGrid);
  // const headerImg = await extractHeaderImage(htmlGrid);
  // const mergedPdf = await MergePDF(gridPdf, userName, uid, bakedBadges, headerImg);
  const mergedPdf = await MergePDF(gridPdf, userName, uid, bakedBadges);


  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=backpack.pdf');
  res.end(mergedPdf);
});

// ****************************************

app.get('/api/downloadBackpackFromEmail', async (req, res) => {

  const token = req.query.token;
  
  let uid;
  try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      uid = decodedToken.uid;
  } catch (error) {
      return res.status(401).send({ error: 'You must be logged in to earn a badge.' });
  }

  // Get the user name
  const userData = await getUserName(uid);
  const userName = userData[0];
  const userPoints = userData[1];

  // Get all badges for the user
  const badges = await getAllBadgesForUser(uid);

  // Bake all badges
  const bakedBadges = {};
  for (const badge of badges) {
    const bakedBadge = await bakeBadge(badge.assertion, badge.imageUrl);
    
    const assertionid = badge.assertion.uid + '.png';
    
    bakedBadges[assertionid] = {
     'data': bakedBadge,
     'name':  badge.name,
     'assertion': badge.assertion
    };    
  }

  const htmlGrid = generateHtmlGrid(badges, userName, userPoints);
  const gridPdf = await htmlToPdf(htmlGrid);
  // const headerImg = await extractHeaderImage(htmlGrid);
  const mergedPdf = await MergePDF(gridPdf, userName, uid, bakedBadges);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=backpack.pdf');
  res.end(mergedPdf);

});
// ****************************************

// Start the server
const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Server running on port ${port}`));
