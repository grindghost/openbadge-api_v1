const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const handlebars = require('handlebars')
const path = require('path')
const fs = require('fs');
const filePath = path.join(__dirname, './template.html');
const source = fs.readFileSync(filePath, 'utf-8').toString();
const template = handlebars.compile(source);

const nodemailer = require("nodemailer");

// async..await is not allowed in global scope, must use a wrapper
async function SendEmail(recipientemail, imgbuffer, badgename, downloadurl, recipient) {

  const fileURL = await uploadFile(imgbuffer, 'badge.png');
  console.log(fileURL);

  // Dynamic replacement for handlebars, in the html template...
  const replacements = {
    badgeimg_cid: 'badgeimg_cid',
    badgename: badgename,
    downloadurl: downloadurl,
    recipient: recipient
  };
  const htmlToSend = template(replacements);

  // Generate test SMTP service account from ethereal.email
  // Only needed if you don't have a real mail account for testing
  // let testAccount = await nodemailer.createTestAccount();

  // create reusable transporter object using the default SMTP transport
  let transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, // true for 465, false for other ports
    auth: {
      user: process.env.ADMIN_EMAIL, // generated ethereal user
      pass: process.env.SMTP_PASSWORD // generated ethereal password

    },
  });


  // send mail with defined transport object
  let info = await transporter.sendMail({
    from: '"Université Laval" <ulaval.devteam@gmail.com>', // sender address
    to: recipientemail, // list of receivers
    subject: " 🎒 Vous avez reçu un nouveau badge!", // Subject line
    // text: "Hello world?", // plain text body
    html: htmlToSend, // html body
    attachments: [{
      filename: 'badge.png',
      // content: imgbuffer,
      // encoding: 'binary',
      path: fileURL,
      // contentDisposition: 'inline',
      cid: 'badgeimg_cid' //same cid value as in the html img src
    },
    {
      filename: 'badge.png',
      encoding: 'binary',
      content: imgbuffer    
    }]
  });

  console.log("Message sent: %s", info.messageId);
  // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>
}

async function uploadFile(buffer, fileName) {
  const params = {
    Bucket: 'your-bucket-name',
    Key: fileName,
    Body: buffer,
    ContentType: 'image/png'
  };

  try {
    const result = await s3.upload(params).promise();
    return result.Location;
  } catch (error) {
    console.error('Error uploading file:', error);
  }
}

// SendEmail().catch(console.error);
module.exports = SendEmail;
