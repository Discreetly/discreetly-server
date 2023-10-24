import type { Express, RequestHandler, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { serverConfig } from '../config/serverConfig';
import { genClaimCodeArray, pp } from '../utils';
import {
  findRoomById,
  findRoomsByIdentity,
  findClaimCode,
  updateClaimCode,
  updateRoomIdentities,
  findUpdatedRooms,
  createRoom,
  createSystemMessages,
  removeRoom,
  removeMessage,
  addIdentityToIdentityListRooms
} from '../data/db/';
import { MessageI, RoomI } from 'discreetly-interfaces';
import { RLNFullProof } from 'rlnjs';
import { SNARKProof as idcProof } from 'idc-nullifier/dist/types/types';
import { SNARKProof } from '../types';
import { verifyIdentityProof } from '../crypto/idcVerifier/verifier';
import { limiter } from './middleware';
import { verifyTheWordProof } from '../gateways/theWord/verifier';

import discordRouter from './gateways/discord';
import ethRouter from './gateways/ethereumGroup';
import theWordRouter from './gateways/theWord';

// import expressBasicAuth from 'express-basic-auth';

const prisma = new PrismaClient();

export function initEndpoints(app: Express, adminAuth: RequestHandler) {
  // This code is used to fetch the server info from the api
  // This is used to display the server info on the client side
  app.use('/discord', discordRouter)
  app.use('/eth', ethRouter)
  app.use('/theword', theWordRouter)

  app.get(['/'], (req, res) => {
    pp('Express: fetching server info');
    res.status(200).json(serverConfig);
  });

  // This code gets a room by its ID, and then checks if room is null.
  // If room is null, it returns a 500 error.
  // Otherwise, it returns a 200 status code and the room object.

  app.get(['/room/:id'], limiter, (req, res) => {
    if (!req.params.id) {
      res.status(400).json({ error: 'Bad Request' });
    } else {
      const requestRoomId = req.params.id ?? '0';
      pp(String('Express: fetching room info for ' + req.params.id));
      findRoomById(requestRoomId)
        .then((room: RoomI) => {
          if (!room) {
            // This is set as a timeout to prevent someone from trying to brute force room ids
            setTimeout(() => res.status(500).json({ error: 'Internal Server Error' }), 1000);
          } else {
            const {
              roomId,
              name,
              rateLimit,
              userMessageLimit,
              membershipType,
              identities,
              bandadaAddress,
              bandadaGroupId
            } = room || {};
            const id = String(roomId);
            const roomResult: RoomI = {
              id,
              roomId,
              name,
              rateLimit,
              userMessageLimit,
              membershipType
            };
            // Add null check before accessing properties of room object
            if (membershipType === 'BANDADA_GROUP') {
              roomResult.bandadaAddress = bandadaAddress;
              roomResult.bandadaGroupId = bandadaGroupId;
            }
            if (membershipType === 'IDENTITY_LIST') {
              roomResult.identities = identities;
            }

            res.status(200).json(roomResult);
          }
        })
        .catch((err) => console.error(err));
    }
  });

  /** This function gets the rooms that a user is a member of.
   * @param {string} idc - The id of the identity to get rooms for.
   * @returns {Array} - An array of room objects.
   */
  app.get(
    ['/rooms/:idc'],
    limiter,
    asyncHandler(async (req: Request, res: Response) => {
      // const { proof } = req.body as { proof: SNARKProof };
      // console.log('PROOF', proof);

      const isValid = await verifyIdentityProof(req.body as idcProof);
      console.log('VALID?', isValid);
      if (isValid) {
        try {
          res.status(200).json(await findRoomsByIdentity(req.params.idc));
        } catch (error) {
          console.error(error);
          res.status(500).json({ error: 'Internal Server Error' });
        }
      }
    })
  );

  /**
   * This code is used to update the room identities of the rooms that the user is joining.
   * The code updates the claim code and sets it to be claimed.
   * It then updates the room identities of the user joining.
   * Finally, it finds the rooms that have been updated and returns them.
   *  @param {string} code - The claim code to be updated
   *  @param {string} idc - The id of the identity to be added to the room
   *  @returns {Array} - An array of room objects
   *  @example {
   *            "code": "string",
   *            "idc": "string"
   *           }
   */
  app.post(
    ['/gateway/join', '/api/gateway/join'],
    limiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsedBody: JoinData = req.body as JoinData;

      if (!parsedBody.code || !parsedBody.idc) {
        res.status(400).json({ message: '{code: string, idc: string} expected' });
      }
      const { code, idc } = parsedBody;
      console.debug('Invite Code:', code);

      const foundCode = await findClaimCode(code);
      if (foundCode && foundCode.expiresAt < Date.now()) {
        await prisma.claimCodes.delete({
          where: {
            claimcode: code
          }
        });
        res.status(400).json({ message: 'Claim Code Expired' });
        return;
      }
      if (foundCode && (foundCode.usesLeft >= 0 || foundCode.usesLeft === -1)) {
        const updatedCode = await updateClaimCode(code, idc);
        if (updatedCode && updatedCode.usesLeft === 0) {
          await prisma.claimCodes.delete({
            where: {
              claimcode: code
            }
          });
        }
      } else {
        res.status(400).json({ message: 'Invalid Claim Code' });
        return;
      }
      const roomIds = foundCode.roomIds;
      const addedRooms = await updateRoomIdentities(idc, roomIds, foundCode.discordId!);
      if (addedRooms.length === 0) {
        res.status(400).json({
          status: 'already-added',
          message: `Identity already exists in ${String(roomIds)}`
        });
      } else {
        const updatedRooms = await findUpdatedRooms(addedRooms);

        // Return the room ids of the updated rooms
        if (updatedRooms.length > 0) {
          res.status(200).json({
            status: 'valid',
            roomIds: updatedRooms.map((room: RoomI) => room.roomId)
          });
        } else {
          res.status(400).json({
            status: 'already-added',
            message: `No rooms found for ${String(roomIds)}`
          });
        }
      }
    })
  );

  interface addRoomData {
    roomName: string;
    rateLimit: number;
    userMessageLimit: number;
    numClaimCodes?: number;
    approxNumMockUsers?: number;
    adminIdentities?: string[];
    roomType?: string;
    bandadaAddress?: string;
    bandadaAPIKey?: string;
    bandadaGroupId?: string;
    membershipType?: string;
    roomId?: string;
    admin?: boolean;
    discordIds?: string[];
  }

  /* ~~~~ ADMIN ENDPOINTS ~~~~ */

  /** createRoom is used to create a new room in the database
   * @param {string} roomName - The name of the room
   * @param {number} rateLimit - The rate limit of the room
   * @param {number} userMessageLimit - The user message limit of the room
   * @param {number} numClaimCodes - The number of claim codes to generate
   * @param {number} approxNumMockUsers - The approximate number of mock users to generate
   * @param {string[]} adminIdentities - The identities of the admins of the room
   * @param {string} type - The type of room
   * @param {string} bandadaAddress - The address of the Bandada group
   * @param {string} bandadaGroupId - The id of the Bandada group
   * @param {string} bandadaAPIKey - The API key of the Bandada group
   * @param {string} membershipType - The type of membership
   * @param {string} roomId - The id of the room
   * @param {string[]} discordIds - The ids of the discord users to add to the room
   * @returns {void}
   * @example {
   *          "roomName": "string",
   *          "rateLimit": number,
   *          "userMessageLimit": number,
   *          "numClaimCodes": number,      // optional
   *          "approxNumMockUsers": number, // optional
   *          "adminIdentities": string[],  // optional
   *          "roomType": "string",         // optional
   *          "bandadaAddress": "string",   // optional
   *          "bandadaGroupId": "string",   // optional
   *          "bandadaAPIKey": "string",    // optional
   *          "membershipType": "string"    // optional if not an IDENTITY_LIST
   *          "roomId": "string",           // optional
   *          "discordIds": string[]        // optional
   *          }
   */
  app.post(['/room/add', '/api/room/add'], adminAuth, (req, res) => {
    const roomMetadata = req.body as addRoomData;
    const roomName = roomMetadata.roomName;
    const rateLimit = roomMetadata.rateLimit;
    const userMessageLimit = roomMetadata.userMessageLimit;
    const numClaimCodes = roomMetadata.numClaimCodes ?? 0;
    const adminIdentities = roomMetadata.adminIdentities;
    const approxNumMockUsers = roomMetadata.approxNumMockUsers;
    const type = roomMetadata.roomType as unknown as string;
    const bandadaAddress = roomMetadata.bandadaAddress;
    const bandadaGroupId = roomMetadata.bandadaGroupId;
    const bandadaAPIKey = roomMetadata.bandadaAPIKey;
    const membershipType = roomMetadata.membershipType;
    const roomId = roomMetadata.roomId;
    createRoom(
      roomName,
      rateLimit,
      userMessageLimit,
      numClaimCodes,
      approxNumMockUsers,
      type,
      adminIdentities,
      bandadaAddress,
      bandadaGroupId,
      bandadaAPIKey,
      membershipType,
      roomId
    )
      .then((result) => {
        const response =
          result === null
            ? { status: 400, message: 'Room already exists' }
            : result
            ? {
                status: 200,
                message: 'Room created successfully',
                roomId: result.roomId,
                claimCodes: result.claimCodes
              }
            : { status: 500, error: 'Internal Server Error' };

        res.status(response.status).json(response);
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ error: String(err) });
      });
  });

  /**
   * This code is used to delete a room from the database.
   *  It takes in the roomId from the request body, and pass it to the removeRoom function.
   *  If removeRoom returns true, it means the room is deleted successfully, and the server returns a 200 status code.
   *  If removeRoom returns false, the server returns a 500 status code.
   *  If removeRoom throws an error, the server returns a 500 status code.
   * @param {string} roomId - The id of the room to be deleted
   * @returns {void}
   *  */

  app.post(
    ['/room/:roomId/delete', '/api/room/:roomId/delete'],
    adminAuth,
    (req: Request, res: Response) => {
      const { roomId } = req.body as { roomId: string };
      removeRoom(roomId)
        .then((result) => {
          if (result) {
            res.status(200).json({ message: 'Room deleted successfully' });
          } else {
            res.status(500).json({ error: 'Internal Server Error' });
          }
        })
        .catch((err) => {
          console.error(err);
          res.status(500).json({ error: String(err) });
        });
    }
  );

  /**
   * This code deletes a message from a room
   * It takes in the roomId and messageId from the request body, and pass it to the removeMessage function.
   * If removeMessage returns true, it means the message is deleted successfully, and the server returns a 200 status code.
   * If removeMessage returns false, the server returns a 500 status code.
   * If removeMessage throws an error, the server returns a 500 status code.
   * @param {string} roomId - The id of the room to be deleted
   * @param {string} messageId - The id of the message to be deleted
   * @returns {void}
   * */

  app.post(
    ['/room/:roomId/message/delete', '/api/room/:roomId/message/delete'],
    adminAuth,
    (req, res) => {
      const { roomId } = req.params;
      const { messageId } = req.body as { messageId: string };

      removeMessage(roomId, messageId)
        .then((result) => {
          if (result) {
            res.status(200).json({ message: 'Message deleted successfully' });
          } else {
            res.status(500).json({ error: 'Internal Server Error' });
          }
        })
        .catch((err) => {
          console.error(err);
          res.status(500).json({ error: String(err) });
        });
    }
  );

  /**
   * This code handles the get request to get a list of messages for a particular room.
   * It uses the Prisma client to query the database and return the messages for a particular room.
   * It also parses the proof from a string to a JSON object.
   * @param {string} id - The id of the room to get messages for
   * @returns {void}
   */
  app.get('/api/room/:id/messages', limiter, (req, res) => {
    const { id } = req.params;
    prisma.messages
      .findMany({
        take: 500,
        orderBy: {
          timeStamp: 'desc'
        },
        where: {
          roomId: id
        },
        select: {
          id: false,
          message: true,
          messageId: true,
          proof: true,
          roomId: true,
          timeStamp: true
        }
      })
      .then((messages) => {
        messages.map((message: MessageI) => {
          message.timeStamp = new Date(message.timeStamp as Date).getTime();
          message.proof = JSON.parse(message.proof as string) as RLNFullProof;
          message.epoch = message.proof.epoch;
        });
        pp('Express: fetching messages for room ' + id);
        res.status(200).json(messages.reverse());
      })
      .catch((error: Error) => {
        pp(error, 'error');
        res.status(500).send('Error fetching messages');
      });
  });

  /**
   * Endpoint to add claim codes to all rooms or a subset of rooms
   * This code adds claim codes to the database.
   * It is used by the admin panel to create claim codes.
   * It takes in the number of codes to create, the rooms to add them to,
   * and whether to add them to all rooms or just the selected ones.
   * It generates the codes, then creates the ClaimCode objects in the database.
   * The codes are added to the specified rooms, and are not claimed.
   * @param {number} numCodes - The number of codes to add to the room
   * @param {string[]} rooms - The ids of the rooms to add codes to
   * @param {boolean} all - Whether to add codes to all rooms or just the selected ones
   * @param {number} expiresAt - The date the codes expire - if not specified, defaults to 3 months from now
   * @param {number} usesLeft - The number of uses left for the codes - if not specified, defaults to -1 (unlimited)
   * @returns {void}
   * @example {
   *          "numCodes": number,
   *          "rooms": string[],
   *          "all": boolean,
   *          "expiresAt": number, // optional
   *          "usesLeft": number   // optional
   *          "discordId": string // optional
   *          }
   */
  app.post(
    ['/addcode', '/api/addcode'],
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { numCodes, rooms, all, expiresAt, usesLeft, discordId } = req.body as {
        numCodes: number;
        rooms: string[];
        all: boolean;
        expiresAt: number;
        usesLeft: number;
        discordId: string;
      };

      const currentDate = new Date();
      const threeMonthsLater = new Date(currentDate).setMonth(currentDate.getMonth() + 3);

      const codeExpires = expiresAt ? expiresAt : threeMonthsLater;
      const query = all ? undefined : { where: { roomId: { in: rooms } } };

      const codes = genClaimCodeArray(numCodes);
      return await prisma.rooms.findMany(query).then((rooms) => {
        const roomIds = rooms.map((room) => room.id);
        const createCodes = codes.map((code) => {
          return prisma.claimCodes
            .create({
              data: {
                claimcode: code.claimcode,
                roomIds: roomIds,
                expiresAt: codeExpires,
                usesLeft: usesLeft,
                discordId: discordId
              }
            })
            .then((newCode) => {
              const updatePromises = rooms.map((room) => {
                return prisma.rooms.update({
                  where: {
                    roomId: room.roomId
                  },
                  data: {
                    claimCodeIds: {
                      push: newCode.id
                    }
                  }
                });
              });
              return Promise.all(updatePromises);
            })
            .catch((err) => {
              console.error(err);
              res.status(500).json({ error: 'Internal Server Error' });
            });
        });

        return Promise.all(createCodes)
          .then(() => {
            res.status(200).json({ message: 'Claim codes added successfully', codes });
          })
          .catch((err) => {
            console.error(err);
            res.status(500).json({ error: 'Internal Server Error' });
          });
      });
    })
  );

  /**
   * Adds claim codes to a room
   *
   * @param {number} numCodes The number of codes to add to the room
   * @param {number} expires The date the codes expire - if not specified, defaults to 3 months from now
   * @param {number} usesLeft The number of uses left for the codes - if not specified, defaults to -1 (unlimited)
   * @param {string} roomId The id of the room to add codes to
   * @returns {void}
   * @example {
   *          "numCodes": number
   *          }
   */
  app.post(['/room/:roomId/addcode', '/api/room/:roomId/addcode'], adminAuth, (req, res) => {
    const { roomId } = req.params;
    const { numCodes, expires, usesLeft } = req.body as {
      numCodes: number;
      expires: number;
      usesLeft: number;
    };
    const codes = genClaimCodeArray(numCodes);

    const currentDate = new Date();
    const threeMonthsLater = new Date(currentDate).setMonth(currentDate.getMonth() + 3);

    const codeExpires = expires ? expires : threeMonthsLater;

    prisma.rooms
      .findUnique({
        where: { roomId: roomId },
        include: { claimCodes: true }
      })
      .then((room) => {
        if (!room) {
          res.status(404).json({ error: 'Room not found' });
          return;
        }
        // Map over the codes array and create a claim code for each code
        const createCodes = codes.map((code) => {
          return prisma.claimCodes.create({
            data: {
              claimcode: code.claimcode,
              expiresAt: codeExpires,
              usesLeft: usesLeft,
              rooms: {
                connect: {
                  roomId: roomId
                }
              }
            }
          });
        });

        return Promise.all(createCodes);
      })
      .then(() => {
        res.status(200).json({ message: 'Claim codes added successfully', codes });
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
      });
  });

  // This fetches the claim/invite codes from the database and returns them as JSON
  app.get(['/logclaimcodes', '/api/logclaimcodes'], adminAuth, (req, res) => {
    pp('Express: fetching claim codes');
    prisma.claimCodes
      .findMany()
      .then((claimCodes) => {
        res.status(401).json(claimCodes);
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
      });
  });

  // GET all rooms from the database and return them as JSON
  app.get(['/rooms', '/api/rooms'], adminAuth, (req, res) => {
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

  app.post(
    ['/change-identity', '/api/change-identity'],
    limiter,
    asyncHandler(async (req: Request, res: Response) => {
      const { generatedProof } = req.body as { generatedProof: idcProof };

      const isValid = await verifyIdentityProof(generatedProof);

      if (isValid) {
        const updatedIdentity = await prisma.gateWayIdentity.update({
          where: {
            semaphoreIdentity: String(generatedProof.publicSignals.identityCommitment)
          },
          data: {
            semaphoreIdentity: String(generatedProof.publicSignals.externalNullifier)
          }
        });
        res.status(200).json({ message: 'Identity updated successfully', updatedIdentity });
      } else {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    })
  );

  /**
   * Sends system messages to the specified room, or all rooms if no room is specified
   * @params {string} message - The message to send
   * @params {string} roomId - The id of the room to send the message to
   * @returns {void}
   * @example {
   *          "message": "string",
   *          "roomId": "string"    // optional
   *          }
   */
  app.post(
    '/admin/message',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { message, roomId } = req.body as {
        message: string;
        roomId?: string;
      };

      try {
        // Function to send system messages
        await createSystemMessages(message, roomId);

        if (roomId) {
          pp(`Express: sending system message: ${message} to ${roomId}`);
          res.status(200).json({ message: `Message sent to room ${roomId}` });
        } else {
          pp(`Express: sending system message: ${message}`);
          res.status(200).json({ message: 'Messages sent to all rooms' });
        }
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    })
  );

  /**
   * This code adds an admin to a room. The admin must be logged in and authorized to add an admin to the room.
   *  The admin must provide the room ID and the identity of the admin to be added.
   *  The code will then add the admin to the room's list of admin identities.
   *  @param {string} roomId - The id of the room to add the admin to
   *  @param {string} idc - The id of the admin to be added
   * @returns {void}
   * @example {
   *         "roomId": "string",
   *        "idc": "string"
   * }
   */

  app.post(
    '/room/:roomId/addAdmin',
    adminAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { roomId } = req.params;
      const { idc } = req.body as { idc: string };
      try {
        await prisma.rooms.update({
          where: {
            roomId: roomId
          },
          data: {
            adminIdentities: {
              push: idc
            }
          }
        });
        res.status(200).json({ message: `Admin added to room ${roomId}` });
      } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    })
  );
