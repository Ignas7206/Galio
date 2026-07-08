const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

setGlobalOptions({ region: 'europe-west1' });
initializeApp();

const db = getFirestore();
const messaging = getMessaging();

exports.checkWarrantyExpiry = onSchedule(
  { schedule: '0 5 * * *', timeZone: 'Europe/Vilnius' },
  async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().slice(0, 10);

    const usersSnap = await db.collection('users').get();

    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      if (!userData.fcmToken) continue;
      if (!userData.notifyEnabled) continue;

      const uid = userDoc.id;
      const warrantiesSnap = await db
        .collection('users').doc(uid)
        .collection('warranties').get();

      for (const wDoc of warrantiesSnap.docs) {
        const w = wDoc.data();
        if (!w.notifyEnabled) continue;
        if (!w.notifyDays || w.notifyDays.length === 0) continue;

        if (w.warrantyEnd) {
          await checkAndNotify({ uid, token: userData.fcmToken, docId: wDoc.id,
            itemName: w.name, dateStr: w.warrantyEnd, notifyDays: w.notifyDays,
            notifyRepeatDays: w.notifyRepeatDays || null, todayStr, type: 'warranty' });
        }

        if (w.returnDeadline && w.notifyReturnDays && w.notifyReturnDays.length > 0) {
          await checkAndNotify({ uid, token: userData.fcmToken, docId: wDoc.id,
            itemName: w.name, dateStr: w.returnDeadline, notifyDays: w.notifyReturnDays,
            notifyRepeatDays: null, todayStr, type: 'return' });
        }
      }
    }
  }
);

async function checkAndNotify({ uid, token, docId, itemName, dateStr, notifyDays, notifyRepeatDays, todayStr, type }) {
  const targetDate = new Date(dateStr);
  targetDate.setHours(0, 0, 0, 0);
  const today = new Date(todayStr);
  const daysLeft = Math.round((targetDate - today) / 86400000);

  let shouldNotify = notifyDays.includes(daysLeft);

  if (!shouldNotify && notifyRepeatDays && daysLeft > 0) {
    if (daysLeft <= (notifyRepeatDays.startDay || 30)) {
      if (daysLeft % (notifyRepeatDays.interval || 7) === 0) shouldNotify = true;
    }
  }

  if (!shouldNotify) return;

  const sentKey = `${docId}_${type}_${todayStr}`;
  const sentRef = db.collection('users').doc(uid).collection('notif_sent').doc(sentKey);
  if ((await sentRef.get()).exists) return;

  const reason = `liko ${daysLeft} d.`;
  const title = type === 'warranty' ? `Garantija baigiasi — ${reason}` : `Grąžinimo laikas — ${reason}`;
  const body = type === 'warranty'
    ? `${itemName}: garantija baigiasi ${dateStr}`
    : `${itemName}: grąžinimo terminas ${dateStr}`;

  try {
    await messaging.send({
      token,
      notification: { title, body },
      webpush: {
        notification: {
          title, body,
          icon: '/icon-192.png',
          tag: `${docId}-${type}`,
          requireInteraction: true,
        },
        fcmOptions: { link: 'https://ignas7206.github.io/Galio/' },
      },
    });
    await sentRef.set({ sentAt: todayStr });
  } catch (e) {
    if (e.code === 'messaging/registration-token-not-registered') {
      await db.collection('users').doc(uid).update({ fcmToken: null });
    }
  }
}

// Kas savaitę išvalo senus notif_sent žurnalus (>60 d.), kad nekauptų vietos
exports.cleanupNotifLogs = onSchedule(
  { schedule: '0 4 * * 1', timeZone: 'Europe/Vilnius' },
  async () => {
    const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const usersSnap = await db.collection('users').get();

    for (const userDoc of usersSnap.docs) {
      const oldLogs = await db.collection('users').doc(userDoc.id)
        .collection('notif_sent')
        .where('sentAt', '<', cutoff)
        .limit(400)
        .get();

      const batch = db.batch();
      oldLogs.docs.forEach(d => batch.delete(d.ref));
      if (oldLogs.size > 0) await batch.commit();
    }
  }
);
