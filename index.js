const Firestore = require('@google-cloud/firestore');
const admin = require('firebase-admin');
admin.initializeApp();

const firestore = new Firestore({
    projectId: 'student-habit-builder',
    timestampsInSnapshots: true,
    // GOOGLE_APPLICATION_CREDENTIALS: './keys',
    keyFilename: './keys/student-habit-builder-41fb56a99ea8.json',
});

let Today = new Date();

let batch = firestore.batch();
let counter = 0;
const promises = [];

const batchSet = (collectionName, data, id) => {
    counter++;
    const ref = id ? firestore.collection(collectionName).doc(id) : firestore.collection(collectionName).doc();
    batch.set(ref, data);

    if (counter >= 500) {
        console.log(`Committing batch of ${counter}`);
        promises.push(batch.commit());
        counter = 0;
        batch = firestore.batch();
    }
}

let messages = [];

const sendBatchMessage = payload => {
    messages.push(payload);

    if (messages.length >= 500) {
        admin.messaging().sendAll(messages)
        .then((response) => {
            console.log(response.successCount + ' messages were sent successfully');
            messages = [];
        }).catch((error) => {
            console.log('Sent failed.\n');
            console.log(error);
        });
    }
}

const pushHistoryData = async () => {
    if (counter) {
        console.log(`Committing batch of ${counter}`);
        promises.push(batch.commit());
    }
    await Promise.all(promises);
}

const timestampToDate = time => {
    if (!time || time === null || time === undefined) {
        return Today;
    }
    if (time.seconds || time.nanoseconds) {
        return new Date(time.seconds * 1000 + time.nanoseconds / 1000000);
    }
    return Today;
}

const isFuture = timestamp => {
    const date = timestampToDate(timestamp);
    return (
        date.getFullYear() >= Today.getFullYear() ||
        date.getMonth() >= Today.getMonth() ||
        date.getDate() >= Today.getDate()
    );
}

const parseToNum = (str, _default = 0) => {
    let num = Number(str);
    if (isNaN(num)) return _default;
    return num;
}

const getHistoryData = habit => {
    const { perDay } = habit;
    const timesADay = parseToNum(habit.timesADay);
    const perDayNum = parseToNum(habit.perDayNum);

    const latestDate = timestampToDate(habit.latestDate || habit.startOn);

    // add to habit list if repeat day is today
    if (!isRepeatToday(habit)) return [];

    // set latestDate date as today (keep hours and minutes)
    const newStartOn = new Date(latestDate);
    newStartOn.setDate(Today.getDate());
    newStartOn.setMonth(Today.getMonth());
    newStartOn.setFullYear(Today.getFullYear());

    // return array of 1 object if it is only 1 time
    if (timesADay <= 1) {
        return [{ ...habit, startOn: newStartOn }];
    }

    // multiple times a day, update the hour and minute
    const arr = [];
    for (let i = 0; i < timesADay; i++) {

        // get the new history latestDate
        if (perDay === 'hour') {
            newStartOn.setHours(latestDate.getHours() + perDayNum * i);
        } else {
            newStartOn.setMinutes(latestDate.getMinutes() + perDayNum * i);
        }

        // avoid duplicate
        if (latestDate.getTime() < newStartOn.getTime()) {
            arr.push({ ...habit, startOn: newStartOn });
        }
    }
    return arr;
}

const isRepeatToday = habit => {

    const { every, weekday = [] } = habit;
    const everyNum = parseToNum(habit.everyNum);

    let repeatDays = everyNum;
    if (every === 'week') {
        repeatDays *= 7;
    }

    // only check for date. so set time to 0
    const latestDate = timestampToDate(habit.latestDate || habit.startOn);
    latestDate.setHours(0,0,0,0);

    const today0 = new Date(Today);
    today0.setHours(0,0,0,0);

    // if repeat every week, it is not exactly 14days
    // check weekday if today falls on the list
    if (every === 'week') {
        const startOn = timestampToDate(habit.startOn);
        const startWeekday = startOn.getDay();
        const todayWeekday = Today.getDay();

        // today is not in the weekday list
        if (weekday.indexOf(todayWeekday) === -1) {
            return false;
        }

        const date = new Date(latestDate);
        date.setHours(0,0,0,0);

        let isToday = false;
        weekday.forEach(w => {
            date.setDate(date.getDate() + repeatDays - startWeekday + w);
            if (today0.getTime() === date.getTime()) {
                isToday = true;
            }
        });
        return isToday;
    }

    // repeat by day, latestDate + repeat === today
    latestDate.setDate(latestDate.getDate() + repeatDays);

    return today0.getTime() === latestDate.getTime();
}

exports.habitRepeat = async (req, res) => {
    const data = (req.body) || {};
    const { action } = data;
    if (!action) {
        return res.status(404).send({
            error: 'No action'
        });
    }

    try {
        if (req.method === 'POST') {
            if (action === 'habit-repeat') {
                if (data.today) {
                    Today = new Date(data.today);
                }

                // get all habit
                const habitSnapshot = await firestore.collection('habit').where('endDate', '>=', Today).get();
                if (habitSnapshot.empty) {
                    console.log('No matching documents.');
                    return;
                }

                const latestHabitDate = {};
                habitSnapshot.forEach(doc => {
                    const habit = doc.data();
                    if (!habit) {
                        return res.status(404).send({
                            error: 'Found document is empty'
                        });
                    }

                    const { endOn, endDate } = habit;
                    if (endOn === 'never' || isFuture(endDate)) {
                        const historyData = getHistoryData(habit);
                        if (historyData && historyData.length) {
                            historyData.forEach(history => {
                                if (history) batchSet('history', { ...history, habitId: doc.id });
                            });
                            latestHabitDate[doc.id] = historyData[historyData.length - 1];
                        }
                    }
                });

                // update habit latestDate
                for (const habitId in latestHabitDate) {
                    const lastestDate = latestHabitDate[habitId].startOn;
                    if (lastestDate) {
                        batchSet('habit', { lastestDate }, habitId);
                    }
                }

                pushHistoryData();

                return res.status(200).send({ ...data, result: `Committing batch of ${counter}` });
            }

            else if (action === 'habit-reminder') {
                const uids = {};

                // get reminder habit and child id
                const historySnapshot = await firestore.collection('history').where('startOn', '==', Today).get();
                if (historySnapshot.empty) {
                    console.log('No matching history documents.');
                    return;
                }
                // map task into user id
                historySnapshot.forEach(doc => {
                    const history = doc.data();
                    const startOn = timestampToDate(history.startOn);
                    const reminderArr = history.reminder.split(" ");
                    const reminder = new Date(startOn);
                    const duration = parseInt(reminderArr[0]);
                    if (isNaN(duration)) {
                        return;
                    }
                    if (reminderArr[1] === "minute") {
                        reminder.setMinutes(reminder.getMinutes() - duration);
                    } else if (reminderArr[1] === "hour") {
                        reminder.setHours(reminder.getHours() - duration);
                    }
                    reminder.setMilliseconds(0);
                    reminder.setSeconds(0);
                    const today = new Date(Today);
                    today.setMilliseconds(0);
                    today.setSeconds(0);
                    if (reminder.getTime() !== today.getTime()) {
                        return;
                    }
                    uids[history.uid] = history;
                });

                // get parent id
                const guardianSnapshot = await firestore.collection('parent_child').where('childId', 'in', Object.keys(uids)).get();
                if (guardianSnapshot.empty) {
                    console.log('No matching parent documents.');
                    return;
                }
                // map habit to user token
                userSnapshot.forEach(doc => {
                    const user = doc.data();
                    if (user.token && uids[doc.id] && uids[doc.id].habitId) {
                        sendBatchMessage({
                            notification: { title: `It's time for habit!`, body: uids[doc.id].habit },
                            tokens: user.token
                        });
                    }
                });

                // ---------------- notify guardiands of completed habit
                const lastMin = new Date(Today);
                lastMin.setMinutes(Today.getMinutes - 1);
                const historySnap = await firestore.collection('history').where('completedOn', '>', lastMin).where('user.isGuardian', '==', false).get();
                if (historySnap.empty) {
                    console.log('No matching history documents.');
                    return;
                }
                // map task into user id
                historySnap.forEach(doc => {
                    const history = doc.data();
                    const guardians = history?.user?.connections;
                    const isNotifyChild = true;
                    if (guardians && guardians.length) {
                        guardians.forEach(user => {
                            if (user.uid === history.completedBy) {
                                isNotifyChild = true;
                            } else if (user?.token) {
                                sendBatchMessage({
                                    notification: { title: `Hooray!`, body: history.habit + ' habit has been completed.' },
                                    tokens: user.token
                                });
                            }
                        });
                        if (isNotifyChild && habit?.user?.token) {
                            sendBatchMessage({
                                notification: { title: `Hooray!`, body: history.habit + ' habit has been completed. Keep it up!' },
                                tokens: habit.user.token
                            });
                        }
                    }
                });
                // ---------------- end habit-complete guardian notification

                let result = '';
                if (messages.length) {
                    admin.messaging().sendAll(messages)
                    .then((response) => {
                        result = response.successCount + ' messages were sent successfully';
                        console.log(result);
                    }).catch((error) => {
                        console.log('Sent failed.\n');
                        console.log(error);
                        return res.status(500).send({
                            error: 'Notification reminder is not sent - Internal Server Error'
                        });
                    });
                }

                return res.status(200).send({ ...data, result });
            }

            return res.status(404).send({
                error: 'Not valid'
            });
        }
    } catch(e) {
        console.error(e);
    }
};
