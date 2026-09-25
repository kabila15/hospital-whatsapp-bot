const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    let preferredIp = null;
    for (const devName in interfaces) {
        const isVirtual = /vEthernet|docker|veth|vmnet|virtual|loopback|wsl/i.test(devName);
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                if (!isVirtual && !alias.address.startsWith('172.')) {
                    return alias.address;
                } else if (!preferredIp && !alias.address.startsWith('172.')) {
                    preferredIp = alias.address;
                }
            }
        }
    }
    return preferredIp || '10.58.160.167';
}
const localIp = getLocalIpAddress();
const localDomain = `${localIp}.nip.io`;
function getDateOptions() {
    const options = [];
    const today = new Date();
    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (let i = 0; i < 4; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;
        
        let label = '';
        if (i === 0) label = `Today (${dateStr})`;
        else if (i === 1) label = `Tomorrow (${dateStr})`;
        else label = `${daysOfWeek[d.getDay()]} (${dateStr})`;
        
        options.push({ key: (i + 1).toString(), dateStr: dateStr, label: label });
    }
    return options;
}
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
let latestQrDataUrl = null;
let clientReady = false;
// --- Configuration ---
const dbOptions = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'myhmsdb'
};
// --- State Management ---
class SessionStore {
    constructor() {
        this.sessions = new Map();
    }
    getSession(phone) {
        return this.sessions.get(phone);
    }
    setSession(phone, data) {
        this.sessions.set(phone, data);
    }
    updateSession(phone, updates) {
        const session = this.getSession(phone) || {};
        this.sessions.set(phone, { ...session, ...updates });
    }
    deleteSession(phone) {
        this.sessions.delete(phone);
    }
}
const sessionStore = new SessionStore();
// --- Database Service ---
class DBService {
    static async getConnection() {
        return await mysql.createConnection(dbOptions);
    }
    static async getPatientByPhone(phone) {
        const db = await this.getConnection();
        const cleanPhone = (phone || '').replace(/[^0-9]/g, '');
        const last10 = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
        const [rows] = await db.execute(
            'SELECT * FROM patreg WHERE contact = ? OR contact = ? OR contact = ? OR RIGHT(REPLACE(REPLACE(contact, " ", ""), "-", ""), 10) = ?',
            [phone, cleanPhone, '91' + last10, last10]
        );
        await db.end();
        return rows.length > 0 ? rows[0] : null;
    }
    static async getLastDoctor(pid) {
        const db = await this.getConnection();
        const [rows] = await db.execute(
            'SELECT doctor FROM appointmenttb WHERE pid = ? ORDER BY appdate DESC, apptime DESC LIMIT 1',
            [pid]
        );
        await db.end();
        return rows.length > 0 ? rows[0].doctor : null;
    }
    static async getDoctorBySpecialty(spec) {
        const db = await this.getConnection();
        const [rows] = await db.execute('SELECT username FROM doctb WHERE spec = ? LIMIT 1', [spec]);
        await db.end();
        return rows.length > 0 ? rows[0].username : null;
    }
    static async getDoctorFees(doctorUsername) {
        const db = await this.getConnection();
        const [rows] = await db.execute('SELECT docFees FROM doctb WHERE username = ? LIMIT 1', [doctorUsername]);
        await db.end();
        return rows.length > 0 ? rows[0].docFees : 500;
    }
    static async getSpecialties() {
        const db = await this.getConnection();
        const [rows] = await db.execute('SELECT DISTINCT spec FROM doctb');
        await db.end();
        return rows.map(r => r.spec);
    }
    static async createAppointment(appointmentData) {
        const db = await this.getConnection();
        const { pid, fname, lname, gender, email, contact, doctor, docFees, appdate, apptime, qr_token } = appointmentData;
        const [countData] = await db.execute('SELECT COUNT(*) as total FROM appointmenttb WHERE doctor=? AND appdate=? AND userStatus=1', [doctor, appdate]);
        const token_no = countData[0].total + 1;
        const session_type = (apptime === '10:00:00') ? 'Morning' : 'Evening';
        const expected_time = apptime;
        const [result] = await db.execute(
            `INSERT INTO appointmenttb (pid, fname, lname, gender, email, contact, doctor, docFees, appdate, apptime, userStatus, doctorStatus, token_no, expected_time, serving_status, session_type, qr_token, paymentStatus) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 0, ?, ?, 'Pending')`,
            [pid, fname, lname, gender, email, contact, doctor, docFees, appdate, apptime, token_no, expected_time, session_type, qr_token]
        );
        await db.end();
        return result.insertId;
    }
    static async cancelAppointment(appointmentId) {
        const db = await this.getConnection();
        await db.execute('UPDATE appointmenttb SET userStatus = 0 WHERE ID = ?', [appointmentId]);
        await db.end();
    }
    static async rescheduleAppointment(appointmentId, rescheduleData) {
        const db = await this.getConnection();
        const { doctor, session_type, token_no, expected_time, fees } = rescheduleData;
        const apptime = (session_type === 'Morning') ? '10:00:00' : '17:00:00';
        await db.execute(
            'UPDATE appointmenttb SET doctor = ?, session_type = ?, token_no = ?, expected_time = ?, apptime = ?, docFees = ? WHERE ID = ?',
            [doctor, session_type, token_no, expected_time, apptime, fees, appointmentId]
        );
        await db.end();
    }
}
// --- Triage Service ---
function suggestSpecialist(symptoms) {
    const s = symptoms.toLowerCase();
    if (s.includes('chest') || s.includes('heart') || s.includes('breath')) return 'Cardiologist';
    if (s.includes('bone') || s.includes('pain') || s.includes('joint') || s.includes('fracture')) return 'Orthopedics';
    if (s.includes('skin') || s.includes('rash') || s.includes('itch')) return 'Dermatologist';
    if (s.includes('headache') || s.includes('brain') || s.includes('nerve')) return 'Neurologist';
    if (s.includes('stomach') || s.includes('digestion')) return 'Gastroenterologist';
    if (s.includes('child') || s.includes('baby')) return 'Pediatrician';
    if (s.includes('eye') || s.includes('vision') || s.includes('blur')) return 'Opthamologist';
    return 'General';
}
// --- Core Flow Handlers ---
async function handleInitialContact(msg, phone, targetJid) {
    console.log(`[INCOMING MESSAGE] Phone "${phone}" | TargetJid "${targetJid}"`);
    const patient = await DBService.getPatientByPhone(phone);
    if (!patient) {
        console.log(`[UNREGISTERED PATIENT] Sending registration link to ${targetJid}.`);
        const welcomeMsg = `Welcome to our Hospital! It looks like you are not registered yet.
Please register on our website to access appointment booking:
http://${localDomain}/q.php?action=register`;
        await safeSendMessage(targetJid, welcomeMsg, { linkPreview: true });
        return;
    }
    const patientName = patient.fname || 'Patient';
    console.log(`[REGISTERED PATIENT] Sending web app guidance message to ${patientName} (${targetJid}).`);
    const registeredMsg = `Hello ${patientName}! Welcome to our Hospital.
Appointment bookings are managed exclusively through our web application.
Please visit our website to book your appointment, view doctor schedules, or track your live queue status:
http://${localDomain}/q.php`;
    await safeSendMessage(targetJid, registeredMsg, { linkPreview: true });
}
// --- Bot Initialization ---
const client = new Client({
    authStrategy: new LocalAuth(),

    puppeteer: {
        executablePath:
            process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',

        headless: true,

      args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-software-rasterizer',
    '--disable-features=Translate,BackForwardCache',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check'
]
    }
});
async function safeSendMessage(to, content, options = {}, retries = 3) {
    for (let i = 0; i <= retries; i++) {
        try {
            if (!clientReady) throw new Error("Client not ready");
            if (client.pupPage && client.pupPage.isClosed()) {
                throw new Error("Puppeteer page is closed - detached frame likely.");
            }
            return await client.sendMessage(to, content, options);
        } catch (err) {
            console.error(`Send message attempt ${i + 1} failed: ${err.message}`);
            if (i === retries) {
                if (err.message.includes('detached Frame') || err.message.includes('closed')) {
                    reinitializeClient().catch(e => console.error("Reinit failed:", e.message));
                }
                throw err;
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}
async function reinitializeClient() {
    console.log('Attempting to re-initialize WhatsApp client...');
    clientReady = false;
    latestQrDataUrl = null;
    try {
        if (client.pupBrowser) {
            await client.pupBrowser.close().catch(() => {});
        }
        await client.destroy().catch(() => {});
    } catch (e) {
        console.log('Error destroying client:', e.message);
    }
    await new Promise(r => setTimeout(r, 3000));
    try {
        client.initialize();
    } catch (e) {
        console.error('Error re-initializing client:', e.message);
    }
}
client.on('qr', (qr) => {
    clientReady = false;
    console.log('QR RECEIVED - Scan this in your WhatsApp linked devices:');
    qrcodeTerminal.generate(qr, { small: true });
    qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
            latestQrDataUrl = url;
        }
    });
});
client.on('ready', () => {
    clientReady = true;
    latestQrDataUrl = null;
    console.log('WhatsApp Bot is ready and listening!');
});
client.on('authenticated', () => {
    console.log('WhatsApp Authenticated successfully.');
});
client.on('auth_failure', msg => {
    console.error('WhatsApp Authentication failure:', msg);
    clientReady = false;
    latestQrDataUrl = null;
});
client.on('disconnected', (reason) => {
    console.log('WhatsApp Client was logged out or disconnected:', reason);
    clientReady = false;
    latestQrDataUrl = null;
    reinitializeClient();
});
// --- Global Exception Handlers ---
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Promise Rejection:', reason);
});
// Use message_create to catch all incoming user messages reliably
client.on('message_create', async msg => {
    if (msg.fromMe) return;
    if (!msg.from || msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter') || msg.from.endsWith('@broadcast') || msg.isStatus) return;
    if (msg.type !== 'chat') return;
    const sender = msg.from;
    let phone = '';
    if (sender.includes('@lid')) {
        try {
            const contact = await msg.getContact();
            phone = contact.number || sender.split('@')[0];
        } catch (e) {
            phone = sender.split('@')[0];
        }
    } else {
        phone = sender.split('@')[0];
    }
    phone = phone.replace(/[^0-9]/g, '');
    if (phone.startsWith('91') && phone.length === 12) {
        phone = phone.substring(2);
    }
    const targetJid = (phone && phone.length >= 10) ? ('91' + phone.slice(-10) + '@c.us') : sender;
    const text = msg.body.trim();
    console.log(`[MSG RECEIVED] sender=${sender} | targetJid=${targetJid} | phone=${phone} | body="${text}"`);
    try {
        await handleInitialContact(msg, phone, targetJid);
    } catch (err) {
        console.error("Error processing message:", err);
    }
});
client.initialize();
// --- Web UI for QR Code & Status ---
app.get('/qr', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (clientReady) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot Status</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0fdf4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); text-align: center; max-width: 420px; border: 1px solid #bbf7d0; }
                    h2 { color: #16a34a; margin-bottom: 10px; }
                    p { color: #4b5563; line-height: 1.5; }
                    .btn { display: inline-block; margin-top: 25px; padding: 12px 24px; background: #ef4444; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>✅ WhatsApp Connected & Ready!</h2>
                    <p>The WhatsApp Chatbot is actively running and ready to handle bookings and send notifications.</p>
                    <a href="/logout" class="btn" onclick="return confirm('Are you sure you want to pair a new WhatsApp account?')">Pair New Account (Get QR Code)</a>
                </div>
            </body>
            </html>
        `);
    }
    if (latestQrDataUrl) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Scan WhatsApp QR Code</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .card { background: white; padding: 35px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); text-align: center; max-width: 420px; }
                    h2 { color: #0f172a; margin-bottom: 8px; }
                    p { color: #64748b; font-size: 14px; margin-bottom: 20px; }
                    img { width: 260px; height: 260px; border-radius: 12px; border: 1px solid #e2e8f0; padding: 10px; }
                    .note { font-size: 12px; color: #94a3b8; margin-top: 15px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>📱 Pair WhatsApp Device</h2>
                    <p>Open WhatsApp on your phone → Settings / Menu → <b>Linked Devices</b> → <b>Link a Device</b> and scan below:</p>
                    <img src="${latestQrDataUrl}" alt="WhatsApp QR Code" />
                    <p class="note">Auto-refreshing every 5 seconds...</p>
                </div>
            </body>
            </html>
        `);
    }
    return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Initializing WhatsApp...</title>
            <meta http-equiv="refresh" content="3">
            <style>
                body { font-family: sans-serif; text-align: center; padding-top: 100px; background: #f8fafc; color: #475569; }
            </style>
        </head>
        <body>
            <h3>⏳ Initializing WhatsApp Client...</h3>
            <p>Please wait a moment while the bot generates a new QR code.</p>
        </body>
        </html>
    `);
});
app.get('/logout', async (req, res) => {
    try {
        console.log('User requested session reset / logout...');
        clientReady = false;
        latestQrDataUrl = null;
        try { await client.destroy(); } catch (e) {}
        const authPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
        await new Promise(r => setTimeout(r, 2000));
        client.initialize();
        return res.redirect('/qr');
    } catch (err) {
        return res.status(500).send('Error resetting session: ' + err.message);
    }
});
// --- Express API Integration for PHP ---
app.post('/send-appointment-notification', async (req, res) => {
    try {
        if (!clientReady) {
            return res.status(503).json({ status: 'error', message: 'WhatsApp client is not ready yet. Please wait a moment.' });
        }
        const { contact, message, appointmentId, patientName, doctorName, date, time } = req.body;
        if (!contact) {
            return res.status(400).json({ status: 'error', message: 'Contact is required' });
        }
        let cleanedContact = contact.replace(/[^0-9]/g, '');
        if (cleanedContact.length === 10) {
            cleanedContact = '91' + cleanedContact;
        }
        const whatsappNumber = cleanedContact + '@c.us';
        if (!clientReady || !client.info || !client.info.wid) {
            console.error("WhatsApp Link Failed: Client not fully initialized yet.");
            return res.status(503).json({ status: 'error', message: 'WhatsApp client is in a transition state. Please try again in a few seconds.' });
        }
        let media = null;
        if (appointmentId && patientName) {
            const qrData = JSON.stringify({
                aptId: appointmentId,
                patient: patientName,
                doctor: doctorName,
                date: date,
                time: time
            });
            const qrImageBase64 = await qrcode.toDataURL(qrData);
            const base64Data = qrImageBase64.replace(/^data:image\/png;base64,/, "");
            media = new MessageMedia('image/png', base64Data, 'appointment_qr.png');
        }
        await new Promise(r => setTimeout(r, 800));
        function formatClickableUrl(text) {
            if (!text) return text;
            let result = text.replace(/\/MABS\/Hospital-Management-System-master\/live_queue\.php\?token=/, '/q.php?token=');
            if (result.includes('.nip.io')) return result;
            return result.replace(/http:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?=\/|\:|$|\s)/g, (m, ip) => 'http://' + ip + '.nip.io');
        }
        if (media) {
            let cleanMessage = formatClickableUrl(message);
            // Extract tracking URL if present
            let trackingUrl = null;
            const linkMatch = cleanMessage.match(/(https?:\/\/[^\s]+)/);
            if (linkMatch) {
                trackingUrl = linkMatch[0];
            }
            // Clean media caption by removing the tracking link block
            let mediaCaption = cleanMessage;
            if (trackingUrl) {
                mediaCaption = cleanMessage.replace(/(?:Track your live queue status here:\s*)?https?:\/\/[^\s]+/, '').trim();
            }
            await safeSendMessage(whatsappNumber, media, { caption: mediaCaption });
            if (trackingUrl) {
                const trackingText = `📊 *Track your live queue status here:*\n${trackingUrl}`;
                await safeSendMessage(whatsappNumber, trackingText, { linkPreview: true });
            }
        } else {
            let cleanMsg = formatClickableUrl(message);
            await safeSendMessage(whatsappNumber, cleanMsg, { linkPreview: true });
        }
        res.json({ status: 'success', message: 'Notification sent successfully' });
    } catch (error) {
        console.error("Error sending notification via Express:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});
app.post('/trigger-emergency-reschedule', async (req, res) => {
    try {
        if (!clientReady) {
            return res.status(503).json({ status: 'error', message: 'WhatsApp client is not ready yet.' });
        }
        const { contact, appointmentId, doctor, leave_date, specialization, options } = req.body;
        if (!contact || !appointmentId || !options) {
            return res.status(400).json({ status: 'error', message: 'Missing parameters' });
        }
        let cleanedContact = contact.replace(/[^0-9]/g, '');
        if (cleanedContact.length === 10) {
            cleanedContact = '91' + cleanedContact;
        }
        const whatsappNumber = cleanedContact + '@c.us';
        sessionStore.setSession(whatsappNumber, {
            step: 'EMERGENCY_RESCHEDULE',
            appointmentId: appointmentId,
            options: options,
            leave_date: leave_date,
            original_doctor: doctor
        });
        let msg = `🚨 *Emergency Reschedule Alert* 🏥\n\nDear Patient, we regret to inform you that Dr. ${doctor} has taken emergency leave for ${leave_date}.\n\nTo ensure you still receive care, we recommend the following alternative doctors with the same specialization (${specialization}) for today:\n\n`;
        
        options.forEach((opt, idx) => {
            msg += `*${idx + 1}*. Dr. ${opt.doctor_name}\n   Session: ${opt.session_type} (${opt.display_time})\n   Token: #${opt.token_no}\n\n`;
        });
        msg += `*${options.length + 1}*. Cancel Appointment\n\nPlease reply with the number of your choice (e.g. *1*, *2*, etc.) to reschedule or cancel.`;
        await safeSendMessage(whatsappNumber, msg);
        return res.json({ status: 'success', message: 'Emergency reschedule triggered.' });
    } catch (err) {
        console.error("Error in trigger-emergency-reschedule endpoint:", err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT} to accept PHP notifications.`);
    console.log(`QR Web Portal available at http://localhost:${PORT}/qr or http://${localIp}:${PORT}/qr`);
});
