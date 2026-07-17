const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

require('dotenv').config()

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    maxHttpBufferSize: 500 * 1024 * 1024
});

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

app.use(express.static("public"));

app.use(express.json({
    limit: "500mb"
}));

const rooms = {};
const roomTransforms = {};
const roomImages = {};
const roomBackground = {};
const roomVideoSettings = {};

const myAccessKey = process.env.MY_ACCESS_KEY
const availableKey = process.env.AVAILABLE_KEY
  ? JSON.parse(process.env.AVAILABLE_KEY)
  : [];
  
io.on("connection", socket => {
    socket.on(
        "join-room",
        ({ roomId, password, accessKey }) => {

        if (!rooms[roomId]) {
            rooms[roomId] = {
                password,
                users: []
            };

            roomImages[roomId] = [];
        }

        if (!roomTransforms[roomId]) {
            roomTransforms[roomId] = {};
        }

        if (!roomVideoSettings[roomId]) {
            roomVideoSettings[roomId] = {};
        }

        const room = rooms[roomId];

        if (room.password !== password) {
            socket.emit(
                "error-message",
                "Wrong password"
            );
            return;
        }

        if (myAccessKey && availableKey) { 
            if (
                accessKey !== myAccessKey &&
                !availableKey.includes(accessKey)
            ) {
                socket.emit(
                    "error-message",
                    "Wrong access key"
                );
                return;
            }
        }

        if (room.users.length >= 4) {
            socket.emit(
                "error-message",
                "Room is full"
            );
            return;
        }

        room.users.push(socket.id);

        socket.join(roomId);
        socket.roomId = roomId;

        socket.emit(
            "all-transforms",
            roomTransforms[roomId]
        );

        socket.emit(
            "all-video-settings",
            roomVideoSettings[roomId]
        ); 

        socket.emit(
            "all-users",
            room.users.filter(
                id => id !== socket.id
            )
        );

        socket.emit(
            "all-images",
            roomImages[roomId]
        );

        socket.emit(
            "background-updated",
            roomBackground[roomId]
        );

        socket.to(roomId).emit(
            "user-joined",
            socket.id
        );
    });


    socket.on(
        "upload-image",
        data => {
            if (!socket.roomId)
                return;

            const roomId = socket.roomId;

            if (
                !data.image ||
                !data.image.startsWith("data:image/png")
            ) {
                socket.emit(
                    "error-message",
                    "Only PNG allowed"
                );
                return;
            }

            const image = {
                id: `${socket.id}-${Date.now()}`,
                owner: socket.id,
                data: data.image,
                dropX: data.dropX,
                dropY: data.dropY,
            };

            roomImages[roomId].push(image);

            io.to(roomId).emit(
                "new-image",
                image
            );
        }
    );


    socket.on(
        "delete-image",
        imageId => {
            if (!socket.roomId)
                return;

            const roomId = socket.roomId;

            const images = roomImages[roomId];

            const index = images.findIndex(
                img => img.id === imageId
            );

            if (index === -1)
                return;

            images.splice(index, 1);

            delete roomTransforms[roomId][imageId];

            io.to(roomId).emit(
                "image-deleted",
                imageId
            );
        }
    );


    socket.on(
        "upload-background",
        data => {
            if (!socket.roomId)
                return;

            const roomId = socket.roomId;

            if (
                !data.image ||
                !data.image.startsWith("data:image/png")
            ) {
                socket.emit(
                    "error-message",
                    "Only PNG allowed"
                );
                return;
            }

            roomBackground[roomId] = data.image;

            io.to(roomId).emit(
                "background-updated",
                data.image
            );
        }
    );


    socket.on(
        "signal",
        data => {
            io.to(data.to).emit(
                "signal",
                {
                    from: socket.id,
                    signal: data.signal
                }
            );
        }
    );


    socket.on(
        "edited-transform",
        data => {
            if (!socket.roomId)
                return;

            roomTransforms[socket.roomId][data.id] = data;

            socket.to(socket.roomId).emit(
                "edited-transform",
                data
            );
        }
    );


    socket.on(
        "edited-video-settings",
        data => {
            if (!socket.roomId)
                return;

            roomVideoSettings[socket.roomId][data.id] = data;

            socket.to(socket.roomId).emit(
                "edited-video-settings",
                data
            );
        }
    );


    socket.on(
        "disconnect",
        () => {
            if (!socket.roomId)
                return;

            const room = rooms[socket.roomId];

            if (!room)
                return;

            room.users =
                room.users.filter(
                    id => id !== socket.id
                );

            socket.to(socket.roomId).emit(
                "user-left",
                socket.id
            );


            if (roomTransforms[socket.roomId]) {
                delete roomTransforms[socket.roomId][socket.id];
            }

            if (roomVideoSettings[socket.roomId]) {
                delete roomVideoSettings[socket.roomId][socket.id];
            }

            if (room.users.length === 0) {
                delete rooms[socket.roomId];
                delete roomTransforms[socket.roomId];
                delete roomVideoSettings[socket.roomId];
                delete roomImages[socket.roomId];
                delete roomBackground[socket.roomId];
            }
        }
    );
});

server.listen(
    7860,
    "0.0.0.0",
    () => {
        console.log(
            "http://localhost:7860"
        );
    }
);
