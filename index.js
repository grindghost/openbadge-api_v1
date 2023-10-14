const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const admin = require('firebase-admin');

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
const MAX_RETRIES = 2;

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
    // const download_backpack_url = `${process.env.BASE_API_URL}api/downloadBackpackFromEmail?token=${token}`;

    // Try to bake the badge before sending it to email (send a baked version)
    // const bakedBadgePNG = await bakeBadgeForEmail(newAssertion, badgeData.image);

    const bakedBadgePNG = await bakeBadge(newAssertion, badgeData.image);

    // Generate a unique token
    const uniqueToken = crypto.randomBytes(16).toString('hex');

    // Save the token in the database along with user information
    await db.ref(`users/${uid}/tokens/${uniqueToken}`).set({
      created: Date.now(),
      valid: true,
    });
    
    // Create the url to download the backpack in the email
    const download_backpack_url = `${process.env.BASE_API_URL}api/downloadBackpackFromEmail?token=${uniqueToken}&uid=${uid}`;

    await SendEmail(userData.email, bakedBadgePNG, badgeData.name, download_backpack_url, userData.name, newAssertion.uid, newAssertion.verify.url);
        
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

async function getPublicConfigs() {
  const db = admin.database();

  // Get the user name
  const configsRef = db.ref(`configs`);
  const configsSnapshot = await configsRef.once('value');
  const configsData = configsSnapshot.val();
  return configsData;
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

    // Get the issuer details
    const issuerUrl = badgeImageData.issuer;
    const issuerUrlLastSegment = issuerUrl.split('/').pop();
    const issuerId = issuerUrlLastSegment.replace('.json', '');

    const issuerRef = db.ref(`issuers/${issuerId}`);
    const issuerSnapshot = await issuerRef.once('value');
    const issuerData = issuerSnapshot.val();

    // Get the assertions details
    const assertionRef = db.ref(`assertions/${value.assertionId}`);
    const assertionSnapshot = await assertionRef.once('value');
    const assertionData = assertionSnapshot.val();

    const revokedDetails = await RetrieveAndUpdateRevocationDetails(assertionData)

    // Get the course details
    const courseRef = db.ref(`courses/${assertionData.course}`);
    const courseSnapshot = await courseRef.once('value');
    const courseData = courseSnapshot.val();

    userBadgesBackpack.push({
      id: key,
      issuer: issuerData,
      course: courseData,
      name: badgeImageData.name,
      imageUrl: badgeImageData.image,
      description: badgeImageData.description,
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

const _generateHtmlGrid = (badges, username, user_points) => {

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


  const styles = `
    @import url('https://fonts.googleapis.com/css2?family=Overpass:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&family=Source+Sans+3:ital,wght@0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=swap');
    * {
      box-sizing: border-box;
      text-rendering: geometricPrecision !important;
    }
    body {
      font-family: 'Overpass', sans-serif;
      margin: 0;
    }
    .page {
      display: flex;
      flex-direction: column;
      height: 11in;
      width: 8.5in;
      page-break-after: always;
    }
   
    .header {
      background-color: white;
      border-bottom: 6px solid #f0f2f5;
      height: auto;
    }
    
    .header img {
      width: 100%;
    }

    .footer {
      background-color: #f0f2f5;
      padding: 24px 24px 24px 24px;
      margin: 16px;
      border-radius: 5px;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Source Sans 3';
      font-size: 12px;
      height: 32px;               /* Fixed height for header/footer */
  }

    .content {
      flex: 1;
      overflow: hidden;
    }

    .grid {
      display: grid;
      grid-auto-rows: 1fr;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      padding: 32px 36px 10px 36px;
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
      font-size: 12px;
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

      strong {
        font-weight: 600;  
      }

  `;

  const header = `
    <div class="header">
      <img class="header-img" src="https://www.dropbox.com/scl/fi/6e4bp0s93hdhk7hty4z35/header.svg?rlkey=svvz6xprj30au8yovt9xqs527&raw=true">
    </div>
    <div class="header-username">
      <span class="username">${username}<br>
        <span class="version">${downloadedOnFrenchDate}</span>
      </span>
      <span class="points">${user_points}<span style="font-size: 10px;">&nbsp;pts</span></span>
      
  </div>
  `;

  const footer = `
    <div class="footer">Développé pour l'Université Laval.</div>
  `;

  const pages = [];

  const firstPageContent = `
    <div class="page">
      ${header}
      <div class="content" style="display: flex; align-items: center; justify-content: center;">
        <img src="https://www.dropbox.com/scl/fi/wfkrnbmg6ka79mwvpkyf6/bp_cover_img.svg?rlkey=5gkuoqzd0uqih7n3nrwvtyasc&raw=true" style="width: 100%;" alt="Mon sac à dos académique">
      </div>
    </div>
  `;

  pages.push(firstPageContent);

  for (let i = 0; i < badges.length; i += 9) {
    const pageContent = `
      <div class="page">
        ${header}
        <div class="content">
          <div class="grid">
          ${badges.slice(i, i + 9).map(badge => {
            if (badge.isPlaceholder) {
                // Adjust the markup for placeholder badges here
                return `
                <div class="card">
                    <img src="${badge.imageUrl}" alt="Placeholder" />
                    <div style="height: 15px; width: 100%; background-color: #f0f2f5; margin: 10px 0;"></div>
                    <div style="height: 15px; width: 70%; background-color: #f0f2f5; margin: 10px auto;"></div>
                    <div style="height: 15px; width: 50%; background-color: #f0f2f5; margin: 10px auto;"></div>
                </div>`;
            } else {    
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
        </div>
        ${footer}
      </div>
    `;
    pages.push(pageContent);
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${styles}</style>
    </head>
    <body>
      ${pages.join('')}
    </body>
    </html>
  `;
};

// ****************************************
// New PDF grid
const generateHtmlGrid = (badges, username, user_points) => {

  // Create a placeholder badge for empty spots
  const placeholderBadge = {
      imageUrl: 'https://www.dropbox.com/scl/fi/pmo6iis7kfgsk90k2thez/empty.png?rlkey=c74t66op8q62y1s5ypxm5u1na&raw=true',
      isPlaceholder: true
  };

  // Fill the grid with placeholder badges until there's a total of 9
  while (badges.length % 3 !== 0) {
      badges.push(placeholderBadge);
  }

  // Create a timestamp
  const timestamp = Date.now();
  const date = new Date(timestamp);
  const downloadedOn = date.toISOString();

  const downloadedOnFrenchDate = _formatDateToFrench(downloadedOn);


  const styles = `
    @import url('https://fonts.googleapis.com/css2?family=Overpass:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&family=Source+Sans+3:ital,wght@0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=swap');
    
    * {
      box-sizing: border-box;
      text-rendering: geometricPrecision !important;
    }
    
    body {
      font-family: 'Overpass', sans-serif;
      margin: 0;
    }
    
    .page {
      display: flex;
      flex-direction: column;
      height: 11in;
      width: 8.5in;
      page-break-after: always;
    }

    .header {
      background-color: white;
      border-bottom: 6px solid #f0f2f5;
      height: auto;
    }

    .header img {
      width: 100%;
    }

    .footer {
      background-color: #f0f2f5;
      padding: 24px 24px 24px 24px;
      margin: 16px;
      border-radius: 5px;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Source Sans 3';
      font-size: 12px;
      height: 32px;               /* Fixed height for header/footer */
    }

    .content {
      flex: 1;
      overflow: hidden;
    }

    .grid {
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: 32px 36px 10px 36px;
    }

    .card {
      border: 1px solid #e0e0e0;
      padding: 15px;
      border-radius: 5px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }


    .attestation-info-col3 img {
      max-width: 80px;
      height: auto;
      position: relative;
      margin-top: 2px;
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
      margin-bottom: 7px;
    }

    strong {
      font-weight: 600;
    }

    .status-band {
      width: fit-content;
      height: 20px;
      line-height: 20px;
      color: black;
      font-weight: bold;
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
      color: #1a93fb;
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

    strong {
      font-weight: 600;
    }

    .badge-container {
      display: flex;
      align-items: center;
      height: 120px;
    }

    .badge-image-wrapper {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .badge-image-wrapper img {
      max-width: 95px;
      margin: 0px 30px 0px 16px;
    }

    .badge-container:after {
      content:  " ";
      background-color: black;
      border-radius: 4px 0px 0px 4px;
      width: 8px;
      height: 88px;
      z-index: 10;
      margin-left: 0px;
      margin-top: 228px;
      position: absolute;
    }

    .attestation-container {
      display: flex;
      justify-content: flex-start;
      align-items: flex-start;
      border: 2px solid #ebeced;
      border-radius: 6px;
      background-color: #f7f7f7;
      overflow: hidden;
      height: 88px;

    }

    .attestation-info-col1 {
      display: flex;         /* Convert this into a flex container */
      flex-direction: column; /* Stack its children vertically */
      justify-content: flex-start;
      width: 300px;
      height: 100%;
      overflow-wrap: break-word;
      border-right: 2px solid #ebeced;
      hyphens: auto;
      padding: 8px 10px 10px 20px;
    }

    .attestation-info-col2 {
      display: flex;         /* Convert this into a flex container */
      flex-direction: column; /* Stack its children vertically */
      justify-content: flex-start;
      width: 290px;
      height: 100%;
      overflow-wrap: break-word;
      hyphens: auto;
      padding: 8px 20px 10px 14px;
    }

    .attestation-info-col3 {
      display: flex;         /* Convert this into a flex container */
      flex-direction: column; /* Stack its children vertically */
      justify-content: flex-start;
      height: 100%;
      padding: 8px 10px 10px 10px;
      flex-grow: 1;
    }

    /* H3 margins correction */
    h3 {
      margin: 0px;
      font-size: 16px;
    }

    .badge-info {
      width: 100%;
      padding-right: 110px;
    }

    .badge-info h3 {
      font-size: 20px;
    }

    .badge-info .badge-id {
      margin-bottom: 12px;
    }

    .badge-points {
      font-size: 14px;
      white-space: nowrap;
      margin-bottom: auto;
    }

    .indented {
      text-indent: -57px;
      padding-left: 57px;
    }

    .badge-description {
      font-weight: 400;
      font-size: 12px !important;
      line-height: 14px !important;
    }

    @font-face {
      font-family: 'Noto Color Emoji';
      src: url(https://raw.githack.com/googlefonts/noto-emoji/main/fonts/NotoColorEmoji.ttf);
    }

   .emoji {
      font-family: 'Noto Color Emoji';
    }


  `;

  const header = `
    <div class="header">
      <img class="header-img" src="https://www.dropbox.com/scl/fi/6e4bp0s93hdhk7hty4z35/header.svg?rlkey=svvz6xprj30au8yovt9xqs527&raw=true">
    </div>
    <div class="header-username">
      <span class="username">${username}<br>
        <span class="version">${downloadedOnFrenchDate}</span>
      </span>
      <span class="points">${user_points}<span style="font-size: 10px;">&nbsp;pts</span></span>
      
  </div>
  `;

  const footer = `
    <div class="footer">👋 Développé pour l'Université Laval.</div>
  `;

  const pages = [];

  const firstPageContent = `
    <div class="page">
      ${header}
      <div class="content" style="display: flex; align-items: center; justify-content: center;">
        <img src="https://www.dropbox.com/scl/fi/wfkrnbmg6ka79mwvpkyf6/bp_cover_img.svg?rlkey=5gkuoqzd0uqih7n3nrwvtyasc&raw=true" style="width: 100%;" alt="Mon sac à dos académique">
      </div>
    </div>
  `;

  pages.push(firstPageContent);

  for (let i = 0; i < badges.length; i += 9) {
    const pageContent = `
      <div class="page">
        ${header}
        <div class="content">
          <div class="grid">
          ${badges.slice(i, i + 3).map(badge => {
            if (badge.isPlaceholder) {
                // Adjust the markup for placeholder badges here
                return `<div class="card" style="height:244px"></div>`;
            } else {    
              console.log('🧙‍♀️', badge)
  
              const statusBand = badge.revokedReason == 'expired' ? 
                                  '<div class="status-band expired">Expiré</div>' :
                                  badge.revokedReason != 'placeholder' ? 
                                  '<div class="status-band revoked">Révoqué</div>' : '';
                                                              
        
                return `

                <!-- <a href="${badge.assertion.verify.url}" target="_blank" alt="assertion"> -->
                <!-- Card -->
                <div class="card">

                    <!-- Badge container -->
                    <div class="badge-container">

                      <div class="badge-image-wrapper">
                        <img src="${badge.imageUrl}" />
                      </div>

                      <!-- Badge informations -->
                      <div class="badge-info">
                        <h3>${badge.name}</h3>
                        <p class="badge-id"><strong>Badge ID:</strong>&nbsp;<a href="#">${badge.id}</a></p>
                        <p class="badge-description">${badge.description}</p>
                      </div>

                      <!-- Points -->
                      <div class="badge-points">
                        ${badge.assertion.points} pts
                      </div>

                    </div>

                    <div class="attestation-container">

                        <div class="attestation-info-col1">
                          <h3>Attestation:</h3>
                          <p><span class="emoji">📦</span>&nbsp;<strong>ID:</strong>&nbsp;<a href="#">${badge.assertion.uid}</a></p>
                          ${statusBand}
                        </div>

                        <div class="attestation-info-col2">
                          <p class="indented"><span class="emoji">🎓</span>&nbsp;<strong>Cours:</strong>&nbsp;<a href="${badge.course.url}" target="_blank">${badge.course.name}</a></p>
                          <p><span class="emoji">🗓</span>&nbsp;<strong>Date:</strong>&nbsp;${formatDateToFrench(badge.assertion.issuedOn)}</p>
                        </div>

                        <div class="attestation-info-col3">

                            <p><strong>Offert par:</strong></p>

                            <!-- Issuer Logo & Details -->
                            <a href="${badge.issuer.url}">
                              <img src="${badge.issuer.image}" />
                            </a>
                        </div>
                    </div>
                </div>`;
            }
        }).join('')}
          </div>
        </div>
        ${footer}
      </div>
    `;
    pages.push(pageContent);
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${styles}</style>
    </head>
    <body>
      ${pages.join('')}
    </body>
    </html>
  `;
};


// ****************************************

// Version using browserless.io
const _htmlToPdf = async (html) => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
    /* args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ] */
  });
  const page = await browser.newPage();
  await page.setContent(html);
  const pdf = await page.pdf({ format: 'letter', printBackground: true });
  await browser.close();
  return pdf;
};


// Version using puppeteer-core and spartacuz
// References:
// https://www.stefanjudis.com/blog/how-to-use-headless-chrome-in-serverless-functions/
const htmlToPdf = async (html, retries = 0) => {
  
  const API_ENDPOINT = process.env.PUPPETEER_WORKER_API;

  try {
    const response = await axios.post(API_ENDPOINT, {
      html: html
    }, {
      responseType: 'arraybuffer' // to handle the binary data
    });

    if (response.status === 200) {
      return response.data;
    } else {
      throw new Error('Failed to generate PDF using the custom API.');
    }

  } catch (error) {
    if (error.response && error.response.status === 504 && retries < MAX_RETRIES) {
        console.error("Vercel tiemout error while generating PDF.");
        console.log("Retrying...", retries + 1, "of", MAX_RETRIES, "retries")
        return htmlToPdf(html, retries + 1);
    } else {
        console.error("Error while generating PDF:", error);
        throw error;
    }
}

  /*
  } catch (error) {
    console.error("Error while generating PDF:", error);
    throw error; // or handle it accordingly
  }
  */
};

// ****************************************

async function MergePDF(BackpackContentPDFBuffer, username, userid, pngBuffers, configsData) {

  // Step 1: Load the first PDF containing the cover and the table of contents
    // const PdfUrl = 'https://www.dropbox.com/scl/fi/v21d3l1andv6b8vn0qrjq/backpack.pdf?rlkey=qa2wuud56pomucf7vm4ni2jsf&raw=true';

    
    // Load the puppeteer PDF
    const firstPdfDoc = await PDFDocument.load(BackpackContentPDFBuffer);

    // Create a new PDF
    const pdfDoc = await PDFDocument.create();

    // Copy all pages from the second PDF and add to new PDF
    const pdfDocumentPages = await pdfDoc.copyPages(firstPdfDoc, Array.from({ length: firstPdfDoc.getPageCount() }, (_, i) => i));
    
    // Add all the pages
    for (const page of pdfDocumentPages) {
        pdfDoc.addPage(page);
    }

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
  date.setHours(date.getHours() - 4);

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
  date.setHours(date.getHours() - 4);

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
  const configsData = await getPublicConfigs();

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
     'assertion': badge.assertion,
    };    
  }

  const htmlGrid = generateHtmlGrid(badges, userName, userPoints);
  const gridPdf = await htmlToPdf(htmlGrid);
  const mergedPdf = await MergePDF(gridPdf, userName, uid, bakedBadges, configsData);


  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=backpack.pdf');
  res.end(mergedPdf);
});

// ****************************************

app.get('/api/downloadBackpackFromEmail', async (req, res) => {

  const { token, uid } = req.query;

  const db = admin.database();

  // Verify the token
  const tokenData = await db.ref(`users/${uid}/tokens/${token}`).once('value').then(snapshot => snapshot.val());

  if (!tokenData || !tokenData.valid) {
    return res.status(401).send({ error: 'Invalid token' });
  }

  // Invalidate the token so it can't be used again (if you want to)
  // await db.ref(`users/${uid}/tokens/${token}`).update({ valid: false });

   // Get the global configs
  const configsData = await getPublicConfigs();

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
  const mergedPdf = await MergePDF(gridPdf, userName, uid, bakedBadges, configsData);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=backpack.pdf');
  res.end(mergedPdf);

});

// ****************************************

// Start the server
const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Server running on port ${port}`));
