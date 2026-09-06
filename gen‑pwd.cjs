const crypto = require('node:crypto');

async function makeUser(username, plainPassword) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.pbkdf2Sync(plainPassword, salt, 100000, 32, 'sha256');
    console.log(`username: ${username}`);
    console.log(`password_salt(hex): ${salt.toString('hex')}`);
    console.log(`password_hash(hex): ${hash.toString('hex')}`);
}

makeUser("admin", "Tocean@788");
