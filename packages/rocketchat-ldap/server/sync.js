/* globals slugify, SyncedCron */

import LDAP from './ldap';

const logger = new Logger('LDAPSync', {});

export function slug(text) {
	if (RocketChat.settings.get('UTF8_Names_Slugify') !== true) {
		return text;
	}
	text = slugify(text, '.');
	return text.replace(/[^0-9a-z-_.]/g, '');
}


export function getLdapUsername(ldapUser) {
	const usernameField = RocketChat.settings.get('LDAP_Username_Field');

	if (usernameField.indexOf('#{') > -1) {
		return usernameField.replace(/#{(.+?)}/g, function(match, field) {
			return ldapUser.object[field];
		});
	}

	return ldapUser.object[usernameField];
}


export function getLdapUserUniqueID(ldapUser) {
	let Unique_Identifier_Field = RocketChat.settings.get('LDAP_Unique_Identifier_Field');

	if (Unique_Identifier_Field !== '') {
		Unique_Identifier_Field = Unique_Identifier_Field.replace(/\s/g, '').split(',');
	} else {
		Unique_Identifier_Field = [];
	}

	let User_Search_Field = RocketChat.settings.get('LDAP_User_Search_Field');

	if (User_Search_Field !== '') {
		User_Search_Field = User_Search_Field.replace(/\s/g, '').split(',');
	} else {
		User_Search_Field = [];
	}

	Unique_Identifier_Field = Unique_Identifier_Field.concat(User_Search_Field);

	if (Unique_Identifier_Field.length > 0) {
		Unique_Identifier_Field = Unique_Identifier_Field.find((field) => {
			return !_.isEmpty(ldapUser.object[field]);
		});
		if (Unique_Identifier_Field) {
			Unique_Identifier_Field = {
				attribute: Unique_Identifier_Field,
				value: ldapUser.raw[Unique_Identifier_Field].toString('hex')
			};
		}
		return Unique_Identifier_Field;
	}
}

export function getDataToSyncUserData(ldapUser, user) {
	const syncUserData = RocketChat.settings.get('LDAP_Sync_User_Data');
	const syncUserDataFieldMap = RocketChat.settings.get('LDAP_Sync_User_Data_FieldMap').trim();

	const userData = {};

	if (syncUserData && syncUserDataFieldMap) {
		const whitelistedUserFields = ['email', 'name', 'customFields'];
		const fieldMap = JSON.parse(syncUserDataFieldMap);
		const emailList = [];
		_.map(fieldMap, function(userField, ldapField) {
			switch (userField) {
				case 'email':
					if (!ldapUser.object.hasOwnProperty(ldapField)) {
						logger.debug(`user does not have attribute: ${ ldapField }`);
						return;
					}

					if (_.isObject(ldapUser.object[ldapField])) {
						_.map(ldapUser.object[ldapField], function(item) {
							emailList.push({ address: item, verified: true });
						});
					} else {
						emailList.push({ address: ldapUser.object[ldapField], verified: true });
					}
					break;

				default:
					if (!_.find(whitelistedUserFields, (el) => el === userField.split('.')[0])) {
						logger.debug(`user attribute not whitelisted: ${ userField }`);
						return;
					}

					const tmpLdapField = RocketChat.templateVarHandler(ldapField, ldapUser.object);
					const userFieldValue = _.reduce(userField.split('.'), (acc, el) => acc[el], user);

					if (tmpLdapField && userFieldValue !== tmpLdapField) {
						userData[userField] = tmpLdapField;
						logger.debug(`user.${ userField } changed to: ${ tmpLdapField }`);
					}
			}
		});

		if (emailList.length > 0) {
			if (JSON.stringify(user.emails) !== JSON.stringify(emailList)) {
				userData.emails = emailList;
			}
		}
	}

	const uniqueId = getLdapUserUniqueID(ldapUser);

	if (uniqueId && (!user.services || !user.services.ldap || user.services.ldap.id !== uniqueId.value || user.services.ldap.idAttribute !== uniqueId.attribute)) {
		userData['services.ldap.id'] = uniqueId.value;
		userData['services.ldap.idAttribute'] = uniqueId.attribute;
	}

	if (user.ldap !== true) {
		userData.ldap = true;
	}

	if (_.size(userData)) {
		return userData;
	}
}


export function syncUserData(user, ldapUser) {
	logger.info('Syncing user data');
	logger.debug('user', {'email': user.email, '_id': user._id});
	logger.debug('ldapUser', ldapUser.object);

	const userData = getDataToSyncUserData(ldapUser, user);
	if (user && user._id && userData) {
		logger.debug('setting', JSON.stringify(userData, null, 2));
		if (userData.name) {
			RocketChat._setRealName(user._id, userData.name);
			delete userData.name;
		}
		Meteor.users.update(user._id, { $set: userData });
		user = Meteor.users.findOne({_id: user._id});
	}

	if (RocketChat.settings.get('LDAP_Username_Field') !== '') {
		const username = slug(getLdapUsername(ldapUser));
		if (user && user._id && username !== user.username) {
			logger.info('Syncing user username', user.username, '->', username);
			RocketChat._setUsername(user._id, username);
		}
	}

	if (user && user._id && RocketChat.settings.get('LDAP_Sync_User_Avatar') === true) {
		const avatar = ldapUser.raw.thumbnailPhoto || ldapUser.raw.jpegPhoto;
		if (avatar) {
			logger.info('Syncing user avatar');

			const rs = RocketChatFile.bufferToStream(avatar);
			const fileStore = FileUpload.getStore('Avatars');
			fileStore.deleteByName(user.username);

			const file = {
				userId: user._id,
				type: 'image/jpeg'
			};

			Meteor.runAsUser(user._id, () => {
				fileStore.insert(file, rs, () => {
					Meteor.setTimeout(function() {
						RocketChat.models.Users.setAvatarOrigin(user._id, 'ldap');
						RocketChat.Notifications.notifyLogged('updateAvatar', {username: user.username});
					}, 500);
				});
			});
		}
	}
}

export function addLdapUser(ldapUser, username, password) {
	const uniqueId = getLdapUserUniqueID(ldapUser);

	const userObject = {};

	if (username) {
		userObject.username = username;
	}

	const userData = getDataToSyncUserData(ldapUser, {});

	if (userData && userData.emails && userData.emails[0] && userData.emails[0].address) {
		if (Array.isArray(userData.emails[0].address)) {
			userObject.email = userData.emails[0].address[0];
		} else {
			userObject.email = userData.emails[0].address;
		}
	} else if (ldapUser.object.mail && ldapUser.object.mail.indexOf('@') > -1) {
		userObject.email = ldapUser.object.mail;
	} else if (RocketChat.settings.get('LDAP_Default_Domain') !== '') {
		userObject.email = `${ username || uniqueId.value }@${ RocketChat.settings.get('LDAP_Default_Domain') }`;
	} else {
		const error = new Meteor.Error('LDAP-login-error', 'LDAP Authentication succeded, there is no email to create an account. Have you tried setting your Default Domain in LDAP Settings?');
		logger.error(error);
		throw error;
	}

	logger.debug('New user data', userObject);

	if (password) {
		userObject.password = password;
	}

	try {
		userObject._id = Accounts.createUser(userObject);
	} catch (error) {
		logger.error('Error creating user', error);
		throw error;
	}

	syncUserData(userObject, ldapUser);

	return {
		userId: userObject._id
	};
}

export function importNewUsers(ldap) {
	if (RocketChat.settings.get('LDAP_Enable') !== true) {
		logger.error('Can\'t run LDAP Import, LDAP is disabled');
		return;
	}

	if (!ldap) {
		ldap = new LDAP();
		ldap.connectSync();
	}

	let count = 0;
	ldap.searchUsersSync('*', Meteor.bindEnvironment((error, ldapUsers, {next} = {}) => {
		if (error) {
			throw error;
		}

		ldapUsers.forEach((ldapUser) => {
			count++;

			const uniqueId = getLdapUserUniqueID(ldapUser);
			// Look to see if user already exists
			const userQuery = {
				'services.ldap.id': uniqueId.value
			};

			logger.debug('userQuery', userQuery);

			let username;
			if (RocketChat.settings.get('LDAP_Username_Field') !== '') {
				username = slug(getLdapUsername(ldapUser));
			}

			// Add user if it was not added before
			const user = Meteor.users.findOne(userQuery);
			if (!user) {
				addLdapUser(ldapUser, username);
			}

			if (!user && username && RocketChat.settings.get('LDAP_Merge_Existing_Users') === true) {
				const userQuery = {
					username
				};

				logger.debug('userQuery merge', userQuery);

				const user = Meteor.users.findOne(userQuery);
				if (user) {
					syncUserData(user, ldapUser);
				}
			}

			if (count % 1000 === 0) {
				logger.info('Imported:', count);
			}
		});
		next && next();
	}));

	logger.info('Imported:', count);
}

function sync() {
	if (RocketChat.settings.get('LDAP_Enable') !== true) {
		return;
	}

	const ldap = new LDAP();

	try {
		ldap.connectSync();

		let users;
		if (RocketChat.settings.get('LDAP_Background_Sync_Keep_Existant_Users_Updated') === true) {
			users = RocketChat.models.Users.findLDAPUsers();
		}

		if (RocketChat.settings.get('LDAP_Background_Sync_Import_New_Users') === true) {
			importNewUsers(ldap);
		}

		if (RocketChat.settings.get('LDAP_Background_Sync_Keep_Existant_Users_Updated') === true) {
			users.forEach(function(user) {
				let ldapUser;

				if (user.services && user.services.ldap && user.services.ldap.id) {
					ldapUser = ldap.getUserByIdSync(user.services.ldap.id, user.services.ldap.idAttribute);
				} else {
					ldapUser = ldap.getUserByUsernameSync(user.username);
				}

				if (ldapUser) {
					syncUserData(user, ldapUser);
				} else {
					logger.info('Can\'t sync user', user.username);
				}
			});
		}
	} catch (error) {
		logger.error(error);
		return error;
	}
	return true;
}

const jobName = 'LDAP_Sync';

const addCronJob = _.debounce(Meteor.bindEnvironment(function addCronJobDebounced() {
	if (RocketChat.settings.get('LDAP_Background_Sync') !== true) {
		logger.info('Disabling LDAP Background Sync');
		if (SyncedCron.nextScheduledAtDate(jobName)) {
			SyncedCron.remove(jobName);
		}
		return;
	}

	if (RocketChat.settings.get('LDAP_Sync_Interval')) {
		logger.info('Enabling LDAP Background Sync');
		SyncedCron.add({
			name: jobName,
			schedule: (parser) => parser.text(RocketChat.settings.get('LDAP_Sync_Interval')),
			job() {
				sync();
			}
		});
	}
}), 500);

Meteor.startup(() => {
	Meteor.defer(() => {
		RocketChat.settings.get('LDAP_Background_Sync', addCronJob);
		RocketChat.settings.get('LDAP_Background_Sync_Interval', addCronJob);
	});
});
