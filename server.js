const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();

const server =
http.createServer(app);

const io =
new Server(server, {
transports: ["websocket"]
});

const PORT = 3000;

// ========================================
// Static files
// ========================================

app.use(
express.static(
path.join(
__dirname,
"public"
)
)
);

app.get(
"/",
(req, res) => {
res.sendFile(
path.join(
__dirname,
"public",
"index.html"
)
);
}
);

// ========================================
// Rooms
//
// Server stores ONLY:
//
// - owner socket ID
// - owner participant ID
// - password
// - connected users
// ========================================

const rooms =
new Map();

// ========================================
// Socket.IO
// ========================================

io.on(
"connection",
socket => {

    console.log(
        "Connected:",
        socket.id
    );


    // ====================================
    // Join Room
    // ====================================

    socket.on(
        "join-room",
        data => {

            const roomId =
                data?.roomId
                    ?.trim();

            const password =
                data?.password ||
                "";

            const participantId =
                data?.participantId
                    ?.trim();


            if (!roomId) {

                socket.emit(
                    "error-message",
                    "Room ID is required."
                );

                return;
            }


            if (!participantId) {

                socket.emit(
                    "error-message",
                    "Participant ID is required."
                );

                return;
            }


            let room =
                rooms.get(
                    roomId
                );


            // =================================
            // Create room
            //
            // First user becomes owner.
            // =================================

            if (!room) {

                room = {

                    owner:
                        socket.id,

                    ownerParticipantId:
                        participantId,

                    password,

                    // Map:
                    //
                    // socket.id
                    //      ↓
                    // participantId
                    //
                    users:
                        new Map()
                };


                rooms.set(
                    roomId,
                    room
                );


                console.log(
                    "Room created:",
                    roomId,
                    "owner socket:",
                    socket.id,
                    "participant:",
                    participantId
                );
            }


            // =================================
            // Password check
            // =================================

            if (
                room.password !==
                password
            ) {

                socket.emit(
                    "error-message",
                    "Wrong password."
                );

                return;
            }


            // =================================
            // Maximum 4 users
            // =================================

            if (
                room.users.size >=
                    4 &&
                !room.users.has(
                    socket.id
                )
            ) {

                socket.emit(
                    "error-message",
                    "Room is full."
                );

                return;
            }


            // =================================
            // Prevent duplicate participant
            //
            // Same participantId cannot
            // occupy two connections in
            // the same room.
            // =================================

            for (
                const [
                    existingSocketId,
                    existingParticipantId
                ]
                of room.users
            ) {

                if (
                    existingParticipantId ===
                    participantId
                ) {

                    socket.emit(
                        "error-message",
                        "Participant is already in this room."
                    );

                    return;
                }
            }


            // =================================
            // Existing users
            //
            // Keep the old all-users event
            // compatible with the current
            // WebRTC code.
            // =================================

            const existingUsers =
                [
                    ...room.users.keys()
                ];


            // =================================
            // Add user
            // =================================

            room.users.set(
                socket.id,
                participantId
            );


            socket.data.roomId =
                roomId;

            socket.data.participantId =
                participantId;


            socket.join(
                roomId
            );


            // =================================
            // Tell new user the participant
            // IDs belonging to those sockets.
            //
            // Format:
            //
            // {
            //     socketId:
            //         participantId
            // }
            // =================================

            const participantMap = {};

            for (
                const [
                    existingSocketId,
                    existingParticipantId
                ]
                of room.users
            ) {

                if (
                    existingSocketId ===
                    socket.id
                ) {
                    continue;
                }

                participantMap[
                    existingSocketId
                ] =
                    existingParticipantId;
            }


            socket.emit(
                "participant-map",
                participantMap
            );


            // =================================
            // Tell new user about existing
            // socket IDs
            //
            // This keeps the existing
            // WebRTC code working.
            // =================================

            socket.emit(
                "all-users",
                existingUsers
            );


            // =================================
            // Tell existing users the
            // participantId of the new user.
            // =================================

            socket
                .to(roomId)
                .emit(
                    "participant-joined",
                    {
                        socketId:
                            socket.id,

                        participantId:
                            participantId
                    }
                );


            // =================================
            // Tell existing users about the
            // new user.
            //
            // Keep user-joined as socket.id
            // for compatibility.
            // =================================

            socket
                .to(roomId)
                .emit(
                    "user-joined",
                    socket.id
                );


            console.log(
                "Joined room:",
                roomId,
                "socket:",
                socket.id,
                "participant:",
                participantId,
                "users:",
                room.users.size
            );
        }
    );


    // ====================================
    // WebRTC signaling
    //
    // Server forwards signaling only.
    //
    // WebRTC continues to use socket.id.
    // ====================================

    socket.on(
        "signal",
        data => {

            if (!data) {
                return;
            }


            const to =
                data.to;


            if (!to) {
                return;
            }


            // Make sure sender is actually
            // inside a room.

            const roomId =
                socket.data.roomId;

            if (!roomId) {
                return;
            }


            const room =
                rooms.get(
                    roomId
                );

            if (!room) {
                return;
            }


            // Make sure target is in
            // the same room.

            if (
                !room.users.has(
                    to
                )
            ) {
                return;
            }


            io.to(to).emit(
                "signal",
                {
                    from:
                        socket.id,

                    signal:
                        data.signal
                }
            );
        }
    );


    // ====================================
    // Disconnect
    // ====================================

    socket.on(
        "disconnect",
        () => {

            console.log(
                "Disconnected:",
                socket.id,
                "participant:",
                socket.data.participantId
            );


            const roomId =
                socket.data.roomId;

            if (!roomId) {
                return;
            }


            const room =
                rooms.get(
                    roomId
                );

            if (!room) {
                return;
            }


            const participantId =
                room.users.get(
                    socket.id
                );


            room.users.delete(
                socket.id
            );


            // =================================
            // Owner left
            //
            // Current design:
            // close the room completely.
            // =================================

            if (
                room.owner ===
                socket.id
            ) {

                io.to(
                    roomId
                ).emit(
                    "room-closed",
                    "Host closed the room."
                );


                rooms.delete(
                    roomId
                );


                console.log(
                    "Room closed:",
                    roomId
                );


                return;
            }


            // =================================
            // Normal user left
            // =================================

            socket
                .to(roomId)
                .emit(
                    "user-left",
                    socket.id
                );


            // =================================
            // Tell clients which participant
            // left.
            // =================================

            socket
                .to(roomId)
                .emit(
                    "participant-left",
                    {
                        socketId:
                            socket.id,

                        participantId:
                            participantId
                    }
                );


            // =================================
            // Remove empty room
            // =================================

            if (
                room.users.size ===
                0
            ) {

                rooms.delete(
                    roomId
                );

                console.log(
                    "Empty room removed:",
                    roomId
                );
            }
        }
    );
}

);

// ========================================
// Start server
// ========================================

server.listen(
PORT,
"0.0.0.0",
() => {

    console.log(
        `Server running at http://localhost:${PORT}`
    );
}

);