"use strict";
let expect = require('expect.js')
let ImapClient = require('emailjs-imap-client')

describe('imapClient', function() {
	let imap
	before(() => {
		imap = new ImapClient('imap.139.com', 143, {
        auth: {
            user: "15313159857@139.com",
            pass: "Draeagi94"
        },
        useSecureTransport: false,
        ignoreTLS: true
    });
    imap.logLevel = imap.LOG_LEVEL_NONE;

    return imap.connect().then(() => {
        return imap.selectMailbox('/Inbox');
    });
  });

	it('listMailboxes', () => {
    return imap.listMailboxes().then((mailboxes) => {
			console.log('listMailboxes result:', mailboxes)
		});
  });

	it('selectMailbox', () => {
    return imap.selectMailbox('INBOX').then((mailbox) => {
			console.log('selectMailbox result:', mailbox)
		});
  });

	after((done) => {
      imap.close().then(() => {
				console.log('close OK')
				done()
			});
  });

});
