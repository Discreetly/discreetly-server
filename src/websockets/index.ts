import { MessageI, RoomI } from 'discreetly-interfaces';
import { Socket, Server as SocketIOServer } from 'socket.io';
import verifyProof from '../crypto/verifier';
import { getRoomByID } from '../data/db';
import { pp } from '../utils';
import { createMessage } from '../data/messages';

const userCount: Record<string, number> = {};

export function websocketSetup(io: SocketIOServer) {
  io.on('connection', (socket: Socket) => {
    pp('SocketIO: a user connected', 'debug');

    socket.on('validateMessage', (msg: MessageI) => {
      pp({ 'VALIDATING MESSAGE ID': String(msg.roomId).slice(0, 11), 'MSG:': msg.message });
      let valid: boolean;
      getRoomByID(String(msg.roomId))
        .then((room: RoomI) => {
          if (!room) {
            pp('INVALID ROOM', 'warn');
            return;
          }
          verifyProof(msg, room)
            .then((v) => {
              valid = v;
              createMessage(String(msg.roomId), msg);
              io.emit('messageBroadcast', msg);
            })
            .catch((err) => {
              err;
            });
          if (!valid) {
            pp('INVALID MESSAGE', 'warn');
            return;
          }
        })
        .catch((err) => pp(err, 'error'));
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
}
