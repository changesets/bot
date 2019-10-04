const nock = require('nock');
const { Probot } = require('probot');
const outdent = require('outdent');

const changesetBot = require('.');

const pullRequestOpen = require('./test/fixtures/pull_request.opened');
const pullRequestSynchronize = require('./test/fixtures/pull_request.synchronize');

nock.disableNetConnect();

describe('changeset-bot', () => {
  let probot;

  beforeEach(() => {
    probot = new Probot({});
    const app = probot.load(changesetBot);

    // just return a test token
    app.app = () => 'test.ts';
  });

  it('should add a comment when there is no comment', async () => {
    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/issues/1/comments')
      .reply(200, []);

    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/pulls/1/files')
      .reply(200, [
        { filename: '.changeset/something/changes.md', status: 'added' },
      ]);

    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/pulls/1/commits')
      .reply(200, [{ sha: 'ABCDE' }]);

    nock('https://api.github.com')
      .post('/repos/pyu/testing-things/issues/1/comments', body => {
        expect(body.comment_id).toBeNull();
        return true;
      })
      .reply(200);

    await probot.receive({
      name: 'pull_request',
      payload: pullRequestOpen,
    });
  });

  it('should update a comment when there is a comment', async () => {
    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/issues/1/comments')
      .reply(200, [
        {
          id: 7,
          user: {
            login: 'changeset-bot[bot]',
          },
        },
      ]);

    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/pulls/1/files')
      .reply(200, [
        { filename: '.changeset/something/changes.md', status: 'added' },
      ]);

    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/pulls/1/commits')
      .reply(200, [{ sha: 'ABCDE' }]);

    nock('https://api.github.com')
      .patch('/repos/pyu/testing-things/issues/comments/7', body => {
        expect(body.number).toBe(1);
        return true;
      })
      .reply(200);

    await probot.receive({
      name: 'pull_request',
      payload: pullRequestSynchronize,
    });
  });

  it('should show correct message if there is a changeset', async () => {
    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/issues/1/comments')
      .reply(200, []);

    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/pulls/1/files')
      .reply(200, [
        { filename: '.changeset/something/changes.md', status: 'added' },
      ]);

    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/pulls/1/commits')
      .reply(200, [{ sha: 'ABCDE' }]);

    nock('https://api.github.com')
      .post('/repos/pyu/testing-things/issues/1/comments', ({ body }) => {
        expect(body).toEqual(outdent`
          ###  🦋  Changeset is good to go
      
          Latest commit: ABCDE
      
          **We got this.**
      
          Not sure what this means? [Click here  to learn what changesets are](https://github.com/Noviny/changesets/blob/master/docs/adding-a-changeset.md).`);
        return true;
      })
      .reply(200);

    await probot.receive({
      name: 'pull_request',
      payload: pullRequestOpen,
    });
  });

  it('should show correct message if there is no changeset', async () => {
    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/issues/1/comments')
      .reply(200, []);

    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/pulls/1/files')
      .reply(200, [{ filename: 'index.js', status: 'added' }]);

    nock('https://api.github.com')
      .get('/repos/pyu/testing-things/pulls/1/commits')
      .reply(200, [{ sha: 'ABCDE' }]);

    nock('https://api.github.com')
      .post('/repos/pyu/testing-things/issues/1/comments', ({ body }) => {
        expect(body).toEqual(outdent`
          ###  💥  No Changeset

          Latest commit: ABCDE
          
          Merging this PR will not cause any packages to be released. If these changes should not cause updates to packages in this repo, this is fine 🙂
          
          **If these changes should be published to npm, you need to add a changeset.**
          
          [Click here to learn what changesets are, and how to add one](https://github.com/Noviny/changesets/blob/master/docs/adding-a-changeset.md).`);
        return true;
      })
      .reply(200);

    await probot.receive({
      name: 'pull_request',
      payload: pullRequestOpen,
    });
  });
});
