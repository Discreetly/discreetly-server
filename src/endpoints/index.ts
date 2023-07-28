import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { serverConfig } from '../config/serverConfig';
import { pp } from '../utils.js';
import { getRoomByID } from '../data/db';
import { genId } from 'discreetly-interfaces';

// TODO! Properly handle authentication for admin endpoints
// TODO api endpoint that creates new rooms and generates invite codes for them

export function initEndpoints(app: Express) {
  const prisma = new PrismaClient();

  app.get(['/', '/api'], (req, res) => {
    pp('Express: fetching server info');
    res.json(serverConfig);
  });

  app.get('/logclaimcodes', (req, res) => {
    pp('Express: fetching claim codes');
    prisma.claimCodes
      .findMany()
      .then((claimCodes) => {
        console.log(claimCodes);
        res.status(401).send('Unauthorized');
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
      });
  });

  app.get('/api/rooms', (req, res) => {
    pp(String('Express: fetching all rooms'));
    prisma.rooms
      .findMany()
      .then((rooms) => {
        res.status(200).json(rooms);
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
      });
  });

  app.get('/api/rooms/:id', (req, res) => {
    // TODO This should return the room info for the given room ID
    pp(String('Express: fetching room info for ' + req.params.id));
    const room = getRoomByID(req.params.id);
    if (!room) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
    res.status(200).json(room);
  });

  app.post('/join', (req, res) => {
    interface JoinRequestBody {
      code: string;
      idc: string;
    }
    console.log(req.body);
    const { code, idc } = req.body as JoinRequestBody;

    pp(`Express[/join]: claiming code: ${code}`);

    prisma.claimCodes
      .findUnique({
        where: {
          claimcode: code
        }
      })
      .then((codeStatus: { claimed: boolean; roomIds: string[] }) => {
        console.log(codeStatus);
        if (codeStatus.claimed === false) {
          prisma.claimCodes
            .update({
              where: {
                claimcode: code
              },
              data: {
                claimed: false //TODO! This should be true and is only false for testing
              }
            })
            .then((claimCode: { roomIds: string[] }) => {
              const roomIds = claimCode.roomIds.map((room) => room);
              prisma.rooms
                .updateMany({
                  where: {
                    roomId: {
                      in: roomIds
                    }
                  },
                  data: {
                    identities: {
                      push: idc
                    }
                  }
                })
                .then(async () => {
                  // return the room name of all the rooms that were updated
                  const updatedRooms = await prisma.rooms.findMany({
                    where: {
                      id: {
                        in: roomIds
                      }
                    }
                  });
                  res.status(200).json(updatedRooms.map((room) => room.roomId));
                })
                .catch((err) => {
                  console.error(err);
                  res.status(500).json({ error: 'Internal Server Error' });
                });
            })
            .catch((err) => {
              console.error(err);
              res.status(500).json({ error: 'Internal Server Error' });
            });
        } else {
          res.status(400).json({ message: 'Claim code already used' });
        }
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
      });
  });

  app.post('/room/add', (req, res) => {
    interface RoomData {
      password: string;
      roomName: string;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const { password, roomName } = req.body.data as RoomData;
    if (password === process.env.PASSWORD) {
      prisma.rooms
        .create({
          data: {
            roomId: genId(BigInt(serverConfig.id), roomName).toString(),
            name: roomName
          }
        })
        .then((newRoom) => {
          res.status(200).json(newRoom);
        })
        .catch((error: Error) => {
          console.error(error);
          res.status(500).send('Error creating new room');
        });
    } else {
      res.status(401).send('Unauthorized');
    }
  });
}
