require("dotenv").config();

function normalizeNumber(number) {
    return String(number || "")
        .replace(/\D/g, "");
}

function isOwner(number) {
    const ownerNumber = normalizeNumber(
        process.env.OWNER_NUMBER
    );

    const senderNumber = normalizeNumber(number);

    return Boolean(
        ownerNumber &&
        senderNumber &&
        ownerNumber === senderNumber
    );
}

module.exports = { isOwner };
