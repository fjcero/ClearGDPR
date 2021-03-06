const { db } = require('../../db');
const winston = require('winston');
const {
  encryptForStorage,
  decryptFromStorage,
  generateClientKey
} = require('../../utils/encryption');
const { recordErasureByProcessor } = require('../../utils/blockchain');
const { ValidationError, NotFound, Forbidden } = require('../../utils/errors');

const PAGE_SIZE = 10; // This could go in constants, inside utils

class SubjectsService {
  constructor(database = db) {
    this.db = database;
  }

  async getSubjectData(subjectId) {
    const [data] = await this.db('subjects')
      .join('subject_keys', 'subjects.id', '=', 'subject_keys.subject_id')
      .select('personal_data')
      .select('key')
      .where({ subject_id: subjectId });

    if (!data) throw new NotFound('Subject not found');
    const decryptedData = decryptFromStorage(data.personal_data, data.key);
    return JSON.parse(decryptedData);
  }

  async initializeUser(subjectId, personalData) {
    await this.db.transaction(async trx => {
      await this._initializeUserInTransaction(trx, subjectId, personalData);
    });
  }

  async _initializeUserInTransaction(trx, subjectId, personalData) {
    const [subject] = await this.db('subjects')
      .transacting(trx)
      .where('id', subjectId)
      .select();

    if (!subject) {
      await this._createNewSubject(personalData, trx, subjectId);
    } else {
      await this._updateExistingSubject(trx, subjectId, personalData);
    }
  }

  async _createNewSubject(personalData, trx, subjectId) {
    const encryptionKey = generateClientKey();
    const encryptedPersonalData = encryptForStorage(JSON.stringify(personalData), encryptionKey);
    await this.db('subjects')
      .transacting(trx)
      .insert({
        id: subjectId,
        personal_data: encryptedPersonalData,
        direct_marketing: true,
        email_communication: true,
        research: true
      });

    await this._saveSubjectEncryptionKey(trx, subjectId, encryptionKey);
  }

  async _updateExistingSubject(trx, subjectId, personalData) {
    const [subjectKey] = await this.db('subject_keys')
      .transacting(trx)
      .where('subject_id', subjectId)
      .select();

    let encryptionKey;
    if (subjectKey) {
      encryptionKey = subjectKey.key;
    } else {
      encryptionKey = generateClientKey();
      await this._saveSubjectEncryptionKey(trx, subjectId, encryptionKey);
    }
    const encryptedPersonalData = encryptForStorage(JSON.stringify(personalData), encryptionKey);
    await this.db('subjects')
      .transacting(trx)
      .where('id', subjectId)
      .update({
        personal_data: encryptedPersonalData,
        updated_at: this.db.raw('CURRENT_TIMESTAMP')
      });
  }

  async _saveSubjectEncryptionKey(trx, subjectId, encryptionKey) {
    await this.db('subject_keys')
      .transacting(trx)
      .insert({
        subject_id: subjectId,
        key: encryptionKey
      });
  }

  async listSubjects(processorId, requestedPage = 1) {
    const [numberOfSubjectsObject] = await this.db('subjects')
      .join('subject_keys', 'subjects.id', '=', 'subject_keys.subject_id')
      .join('subject_processors', 'subjects.id', '=', 'subject_processors.subject_id')
      .where({
        'subject_processors.processor_id': processorId
      })
      .whereNotNull('personal_data')
      .whereNotNull('key')
      .count('personal_data');

    const numberOfSubjects = numberOfSubjectsObject.count;
    let totalPages = Math.ceil(numberOfSubjects / PAGE_SIZE);
    if (totalPages === 0) {
      // Handles the case in which there are no valid subjects, with valid encryption keys and all, in the db
      totalPages = 1;
    }
    if (requestedPage > totalPages) {
      throw new ValidationError(`page number too big, maximum page number is ${totalPages}`);
    }
    if (requestedPage < 1) {
      throw new ValidationError('Minimum page number is 1');
    }
    const encryptedSubjectsData = await this.db('subjects')
      .join('subject_keys', 'subjects.id', '=', 'subject_keys.subject_id')
      .join('subject_processors', 'subjects.id', '=', 'subject_processors.subject_id')
      .select('subjects.id', 'subjects.created_at')
      .whereNotNull('personal_data')
      .whereNotNull('key')
      .where({
        'subject_processors.processor_id': processorId
      })
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .offset((requestedPage - 1) * PAGE_SIZE);

    return {
      data: encryptedSubjectsData,
      paging: {
        current: requestedPage,
        total: totalPages
      }
    };
  }

  async eraseDataAndRevokeConsent(subjectId) {
    await this.db.transaction(async trx => {
      await this.db('subject_keys')
        .transacting(trx)
        .where('subject_id', subjectId)
        .del();

      await this.db('subject_processors')
        .transacting(trx)
        .where({
          subject_id: subjectId
        })
        .del();

      winston.info('Emitting erasure event to blockchain');
      await recordErasureByProcessor(subjectId);
    });
  }

  async restrict(subjectId, directMarketing, emailCommunication, research) {
    const subjectRestrictionsUpdates = await this.db('subjects')
      .where('id', subjectId)
      .update({
        direct_marketing: directMarketing,
        email_communication: emailCommunication,
        research: research
      });

    if (subjectRestrictionsUpdates === 0) throw new NotFound('Subject not found');
    if (subjectRestrictionsUpdates > 1) throw new Forbidden('Duplicated subject in the database');
  }

  async getSubjectRestrictions(subjectId) {
    const [subjectRestrictions] = await this.db('subjects')
      .where('id', subjectId)
      .select('direct_marketing', 'email_communication', 'research');

    if (!subjectRestrictions) throw new NotFound('Subject not found');
    return subjectRestrictions;
  }

  async object(subjectId, objection) {
    const subjectObjectionUpdates = await this.db('subjects')
      .where('id', subjectId)
      .update({
        objection: objection
      });

    if (subjectObjectionUpdates === 0) throw new NotFound('Subject not found');
    // There is a bug in the above line!! When it is 0, it's breaking
    if (subjectObjectionUpdates > 1) throw new Forbidden('Duplicated subject in the database');
  }

  async getSubjectObjection(subjectId) {
    const [subjectObjection] = await this.db('subjects')
      .where('id', subjectId)
      .select('objection');

    if (!subjectObjection) throw new NotFound('Subject not found');
    return subjectObjection;
  }
}

module.exports = SubjectsService;
