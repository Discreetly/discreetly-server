import * as express from 'express';
import { Server } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import * as cors from 'cors';
import { createClient } from 'redis';
import { serverConfig, rooms as defaultRooms, rooms } from '../config/rooms';
import { MessageI, RoomGroupI } from 'discreetly-interfaces';
import verifyProof from './verifier';
import ClaimCodeManager from 'discreetly-claimcodes';
import type { ClaimCodeStatus } from 'discreetly-claimcodes';
import { pp, addIdentityToRoom } from './utils';
import { faker } from '@faker-js/faker';

// HTTP is to get info from the server about configuration, rooms, etc
const HTTP_PORT = 3001;
// Socket is to communicate chat room messages back and forth
const SOCKET_PORT = 3002;
// Testing Mode
const TESTING = true;

// Deal with bigints in JSON
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app = express();

const socket_server = new Server(app);
app.use(express.json());

const io = new SocketIOServer(socket_server, {
  cors: {
    origin: '*'
  }
});

interface userCountI {
  [key: string]: number;
}

let userCount: userCountI = {};
let loadedRooms: RoomGroupI[];
// TODO get the claim code manager working with redis to store the state of the rooms and claim codes in a redis database that persists across server restarts
// Redis

const redisClient = createClient();
redisClient.connect().then(() => pp('Redis Connected'));

let ccm: ClaimCodeManager;

redisClient.get('ccm').then((cc) => {
  if (!cc) {
    ccm = new ClaimCodeManager();
    ccm.generateClaimCodeSet(10, 999, 'TEST');
    const ccs = ccm.getClaimCodeSets();
    redisClient.set('ccm', JSON.stringify(ccs));
  } else {
    ccm = new ClaimCodeManager(JSON.parse(cc));

    if (ccm.getUsedCount(999).unusedCount < 5) {
      ccm.generateClaimCodeSet(10, 999, 'TEST');
      const ccs = ccm.getClaimCodeSets();

      redisClient.set('ccm', JSON.stringify(ccs));
    }
  }
});

redisClient.get('rooms').then((rooms) => {
  rooms = JSON.parse(rooms);
  if (rooms) {
    loadedRooms = rooms as RoomGroupI[];
  } else {
    loadedRooms = defaultRooms;
    redisClient.set('rooms', JSON.stringify(loadedRooms));
  }
  pp({ 'Loaded Rooms': loadedRooms });
});

redisClient.on('error', (err) => pp('Redis Client Error: ' + err, 'error'));

io.on('connection', (socket: Socket) => {
  pp('SocketIO: a user connected', 'debug');

  socket.on('validateMessage', (msg: MessageI) => {
    pp({ 'VALIDATING MESSAGE ID': msg.id.slice(0, 11), 'MSG:': msg.message });
    const timestamp = Date.now().toString();
    const valid = verifyProof(msg);
    if (!valid) {
      pp('INVALID MESSAGE', 'warn');
      return;
    }
    io.emit('messageBroadcast', msg);
  });

  socket.on('disconnect', () => {
    pp('SocketIO: user disconnected');
  });

  socket.on('joinRoom', (roomID: bigint) => {
    const id = roomID.toString();
    userCount[id] = userCount[id] ? userCount[id] + 1 : 1;
  });

  socket.on('leaveRoom', (roomID: bigint) => {
    const id = roomID.toString();
    userCount[id] = userCount[id] ? userCount[id] - 1 : 0;
  });
});

app.use(
  cors({
    origin: '*'
  })
);

app.get(['/', '/api'], (req, res) => {
  pp('Express: fetching server info');
  res.json(serverConfig);
});

app.get('/api/rooms', (req, res) => {
  pp('Express: fetching rooms');
  res.json(loadedRooms);
});

app.get('/api/rooms/:id', (req, res) => {
  // TODO This should return the room info for the given room ID
  pp(String('Express: fetching room info for ' + req.params.id));
  const room = loadedRooms
    .flatMap((rooms) => rooms.rooms)
    .filter((room) => room.id === req.params.id);
  res.json(room);
});

// TODO api endpoint that creates new rooms and generates invite codes for them
const testGroupId0 = '917472730658974787195329824193375792646499428986660190540754124137738350241';
const testGroupId1 = '355756154407663058879850750536398206548026044600409795496806929599466182253';
app.post('/join', (req, res) => {
  const data = req.body;
  console.log(data);
  const { code, idc } = data;
  pp('Express[/join]: claiming code:' + code);
  const result: ClaimCodeStatus = ccm.claimCode(code);
  const groupID = result.groupID;
  if (result.status === 'CLAIMED') {
    redisClient.set('ccm', JSON.stringify(ccm.getClaimCodeSets()));
    addIdentityToRoom(testGroupId1, idc);
    pp('Express[/join]Code claimed: ' + code);
    res.status(200).json({ groupID });
  } else {
    res.status(451).json({ status: 'invalid' });
  }
});

app.get('/logclaimcodes', (req, res) => {
  pp('-----CLAIMCODES-----', 'debug');
  pp(ccm.getClaimCodeSets());
  pp('-----ENDOFCODES-----', 'debug');
});

app.listen(HTTP_PORT, () => {
  pp(`Express Http Server is running at http://localhost:${HTTP_PORT}`);
});

socket_server.listen(SOCKET_PORT, () => {
  pp(`SocketIO Server is running at http://localhost:${SOCKET_PORT}`);
});

// Disconnect from redis on exit
process.on('SIGINT', () => {
  pp('disconnecting redis');
  redisClient.disconnect().then(process.exit());
});

// TODO we are going to need endpoints that take a password that will be in a .env file to generate new roomGroups, rooms, and claim codes

if (TESTING) {
  class randomMessagePicker {
    values: any;
    weightSums: any[];
    constructor(values, weights) {
      this.values = values;
      this.weightSums = [];
      let sum = 0;

      for (let weight of weights) {
        sum += weight;
        this.weightSums.push(sum);
      }
    }

    pick() {
      const rand = Math.random() * this.weightSums[this.weightSums.length - 1];
      let index = this.weightSums.findIndex((sum) => rand < sum);
      return this.values[index]();
    }
  }

  const values = [
    faker.finance.ethereumAddress,
    faker.company.buzzPhrase,
    faker.lorem.sentence,
    faker.hacker.phrase
  ];
  const weights = [1, 3, 2, 8];
  const picker = new randomMessagePicker(values, weights);

  setInterval(() => {
    const message: MessageI = {
      id: faker.number.bigInt(),
      room: '7458174823225695762087107782399226439860424529052640186229953289032606624581',
      message: picker.pick(),
      timestamp: Date.now().toString(),
      epoch: Math.floor(Date.now() / 10000)
    };
    console.log('SENDING TEST MESSAGE');
    io.emit('messageBroadcast', message);
  }, 10000);
}
