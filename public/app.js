await window.electronAPI.stopSpout();

const socket = io(window.location.host, {
    transports: ["websocket"],
    reconnection: true
});

const scene = document.getElementById("scene");
const joinBtn = document.getElementById("joinBtn");
const spout2Select = document.getElementById("spout2Select");

const peers = {};
const transforms = {};

let currentBackground = "";

const dataChannels = {};

const mouse = {
    x: 0,
    y: 0
};

let localStream = null;

// ========================================
// Room state
// ========================================

let isRoomOwner = false;
let loadSceneEnabled = false;
let joinedRoom = false;

let currentRoomId = "";
let currentRoomPassword = "";


// ========================================
// Local scene persistence
// ========================================

function saveLocalScene() {
    if (!isRoomOwner) {
        return;
    }

    if (!loadSceneEnabled) {
        return;
    }

    try {
        const images = [];

        document
            .querySelectorAll(".image-box")
            .forEach(box => {
                const id = box.id.replace("box-", "");

                const img = box.querySelector("img");

                if (!img || !img.src) {
                    return;
                }

                images.push({
                    id,
                    data: img.src
                });
            });

        const data = {
            background:
                scene.style.backgroundImage || "",

            images,

            transforms: JSON.parse(
                JSON.stringify(transforms)
            )
        };

        localStorage.setItem(
            "saved-scene",
            JSON.stringify(data)
        );

    } catch (err) {
        console.error(
            "Could not save local scene:",
            err
        );
    }
}


function loadSavedScene() {
    if (!isRoomOwner) {
        return;
    }

    if (!loadSceneEnabled) {
        return;
    }

    try {
        const raw =
            localStorage.getItem("saved-scene");

        if (!raw) {
            return;
        }

        const data =
            JSON.parse(raw);

        // ----------------------------
        // Background
        // ----------------------------

        if (
            data.background &&
            data.background !== "none"
        ) {
            scene.style.backgroundImage =
                data.background;

            scene.style.backgroundSize =
                "cover";

            scene.style.backgroundPosition =
                "center";
        }

        // ----------------------------
        // Transforms
        // ----------------------------

        if (data.transforms) {
            Object.assign(
                transforms,
                data.transforms
            );
        }

        // ----------------------------
        // Images
        // ----------------------------

        if (
            Array.isArray(data.images)
        ) {
            for (const image of data.images) {
                if (!image.data) {
                    continue;
                }

                addImage({
                    id: image.id,
                    data: image.data,
                    dropX:
                        transforms[image.id]?.x ??
                        100,
                    dropY:
                        transforms[image.id]?.y ??
                        100
                });
            }
        }

        // Reapply transforms after
        // all image elements exist.

        for (
            const id of Object.keys(
                transforms
            )
        ) {
            applyEditedTransform(id);
        }

        console.log(
            "Loaded local scene:",
            "saved-scene"
        );

    } catch (err) {
        console.error(
            "Could not load local scene:",
            err
        );
    }
}

document
    .getElementById("clearSceneBtn")
    .onclick = () => {

        if (
            !localStorage.getItem("saved-scene")
        ) {
            alert("No saved scene.");
            return;
        }

        const confirmed =
            confirm(
                "Clear saved scene?"
            );

        if (!confirmed) {
            return;
        }

        localStorage.removeItem(
            "saved-scene"
        );

        alert(
            "Saved scene cleared."
        );
    };


// ========================================
// Participant Id
// ========================================

let participantId =
    localStorage.getItem("participant-id");

if (!participantId) {
    participantId =
        crypto.randomUUID();

    localStorage.setItem(
        "participant-id",
        participantId
    );
}


// ========================================
// Participant Map
// socket.id -> participantId
// ========================================

const participantMap = {};

participantMap[socket.id] = participantId;

let participantMapReady = false;

socket.on(
    "participant-map",
    map => {

        if (
            !map ||
            typeof map !== "object"
        ) {
            return;
        }

        for (
            const [socketId, id]
            of Object.entries(map)
        ) {

            // Ignore broken entries
            if (
                !socketId ||
                socketId === "undefined" ||
                !id
            ) {
                continue;
            }

            participantMap[socketId] = id;
        }

        participantMapReady = true;

        console.log(
            "Participant map:",
            participantMap
        );
    }
);

socket.on(
    "participant-joined",
    data => {

        if (!data) {
            return;
        }

        const socketId =
            data.socketId;

        const id =
            data.participantId;

        if (
            !socketId ||
            !id
        ) {
            console.warn(
                "Invalid participant-joined:",
                data
            );
            return;
        }

        participantMap[socketId] = id;

        console.log(
            "Participant joined:",
            socketId,
            id
        );
    }
);


// ========================================
// WebRTC Config
// ========================================

const configuration = {
    iceServers: [
        {
            urls:
                "stun:stun.l.google.com:19302"
        }
    ]
};


// ========================================
// Spout2
// ========================================

let lastSenders = "";
let currentSender = "";

function refreshSenders() {
    const senders =
        window.spout.getSenders();

    const json =
        JSON.stringify(senders);

    if (json === lastSenders) {
        return;
    }

    lastSenders = json;

    const current =
        spout2Select.value;

    spout2Select.innerHTML = "";

    for (const s of senders) {
        const option =
            document.createElement(
                "option"
            );

        option.value = s;
        option.textContent = s;

        spout2Select.appendChild(
            option
        );
    }

    if (senders.includes(current)) {
        spout2Select.value =
            current;
    }

    if (
        currentSender === "" &&
        spout2Select.value
    ) {
        window.spout.setSender(
            spout2Select.value
        );

        currentSender =
            spout2Select.value;
    }
}

spout2Select.addEventListener(
    "input",
    () => {
        window.spout.setSender(
            spout2Select.value
        );

        currentSender =
            spout2Select.value;
    }
);

refreshSenders();

setInterval(
    refreshSenders,
    1000
);


// ========================================
// Video canvases
// ========================================

const videoCanvas =
    document.getElementById(
        "videoCanvas"
    );

const mainVideo =
    document.getElementById(
        "mainVideo"
    );

const mainCanvas =
    document.getElementById(
        "mainCanvas"
    );


// ========================================
// RGBA -> two WebRTC tracks
// ========================================

const ctx =
    videoCanvas.getContext(
        "2d",
        {
            alpha: true,
            willReadFrequently: true
        }
    );

const alphaCanvas =
    document.createElement(
        "canvas"
    );

const alphaCtx =
    alphaCanvas.getContext(
        "2d",
        {
            alpha: false,
            willReadFrequently: true
        }
    );

const tmpCanvas =
    document.createElement(
        "canvas"
    );

const tmpCtx =
    tmpCanvas.getContext(
        "2d",
        {
            alpha: true,
            willReadFrequently: true
        }
    );

const colorStream =
    videoCanvas.captureStream(60);

const alphaStream =
    alphaCanvas.captureStream(60);

const localColorTrack =
    colorStream.getVideoTracks()[0];

const localAlphaTrack =
    alphaStream.getVideoTracks()[0];

mainVideo.srcObject =
    colorStream;

mainVideo.muted = true;
mainVideo.playsInline = true;

mainVideo.play().catch(
    () => {}
);

const localSceneCanvases =
    new Set();


// ========================================
// Spout render
// ========================================

function render() {
    let frame = null;

    try {
        frame =
            window.spout.receiveFrame();
    } catch (err) {
        console.error(
            "Spout receiveFrame error:",
            err
        );
    }

    if (
        frame &&
        frame.data &&
        frame.width > 0 &&
        frame.height > 0 &&
        frame.data.length ===
            frame.width *
            frame.height *
            4
    ) {
        if (
            videoCanvas.width !==
                frame.width ||
            videoCanvas.height !==
                frame.height
        ) {
            videoCanvas.width =
                frame.width;

            videoCanvas.height =
                frame.height;

            alphaCanvas.width =
                frame.width;

            alphaCanvas.height =
                frame.height;

            tmpCanvas.width =
                frame.width;

            tmpCanvas.height =
                frame.height;
        }

        try {
            const rgba =
                new Uint8ClampedArray(
                    frame.data
                );

            const imageData =
                new ImageData(
                    rgba,
                    frame.width,
                    frame.height
                );

            tmpCtx.putImageData(
                imageData,
                0,
                0
            );

            ctx.clearRect(
                0,
                0,
                videoCanvas.width,
                videoCanvas.height
            );

            ctx.drawImage(
                tmpCanvas,
                0,
                0
            );

            const alphaImageData =
                alphaCtx.createImageData(
                    frame.width,
                    frame.height
                );

            const alphaData =
                alphaImageData.data;

            let src = 3;

            for (
                let i = 0;
                i < alphaData.length;
                i += 4
            ) {
                const a =
                    rgba[src];

                alphaData[i] = a;
                alphaData[i + 1] = a;
                alphaData[i + 2] = a;
                alphaData[i + 3] = 255;

                src += 4;
            }

            alphaCtx.putImageData(
                alphaImageData,
                0,
                0
            );

            for (
                const canvas
                of localSceneCanvases
            ) {
                if (
                    canvas.width !==
                        frame.width ||
                    canvas.height !==
                        frame.height
                ) {
                    canvas.width =
                        frame.width;

                    canvas.height =
                        frame.height;
                }

                const localCtx =
                    canvas.getContext(
                        "2d",
                        {
                            alpha: true
                        }
                    );

                localCtx.clearRect(
                    0,
                    0,
                    canvas.width,
                    canvas.height
                );

                localCtx.drawImage(
                    videoCanvas,
                    0,
                    0
                );
            }

        } catch (err) {
            console.error(
                "Frame decode error:",
                err
            );
        }
    }

    requestAnimationFrame(
        render
    );
}

render();


// ========================================
// WebRTC state
// ========================================

const remoteTrackInfo = {};
const pendingRemoteTracks = {};
const pendingIceCandidates = {};


// ========================================
// Configure sender
// ========================================

async function configureSender(
    sender,
    maxBitrate
) {
    if (
        !sender ||
        !sender.track
    ) {
        return;
    }

    try {
        const params =
            sender.getParameters();

        if (
            !params.encodings ||
            params.encodings.length === 0
        ) {
            params.encodings = [{}];
        }

        params.encodings[0]
            .maxBitrate =
            maxBitrate;

        params.encodings[0]
            .scaleResolutionDownBy =
            1;

        params.encodings[0]
            .maxFramerate =
            30;

        params.degradationPreference =
            "maintain-resolution";

        await sender.setParameters(
            params
        );

    } catch (err) {
        console.warn(
            "Could not configure sender:",
            err
        );
    }
}


// ========================================
// Join Room
// ========================================

joinBtn.onclick = async () => {
    const roomId =
        document
            .getElementById("roomId")
            .value
            .trim();

    const password =
        document
            .getElementById("password")
            .value
            .trim();

    const continueScene =
        document
            .getElementById(
                "continueScene"
            )
            .checked;

    if (!roomId) {
        alert(
            "Please enter Room ID."
        );
        return;
    }

    try {
        localStream =
            colorStream;

        currentRoomId =
            roomId;

        currentRoomPassword =
            password;

        loadSceneEnabled =
            continueScene;

        socket.emit(
            "join-room",
            {
                roomId,
                password,
                participantId
            }
        );

        await window.electronAPI.startSpout();

    } catch (err) {
        console.error(err);

        alert(
            "Could not join room."
        );
    }
};


// ========================================
// Socket Events
// ========================================

socket.on(
    "error-message",
    message => {
        alert(message);
    }
);


// ========================================
// all-users
//
// IMPORTANT:
//
// [] means this user is the first
// person in the room.
//
// Therefore this user is the
// room creator / owner.
// ========================================

socket.on(
    "all-users",
    async users => {

        // Wait for participant-map
        // because server sends it separately.
        while (!participantMapReady) {
            await new Promise(
                resolve =>
                    setTimeout(resolve, 10)
            );
        }

        isRoomOwner =
            users.length === 0;

        console.log(
            "Room owner:",
            isRoomOwner
        );

        if (
            !document.getElementById(
                `box-${participantId}`
            )
        ) {
            createLocalVideo();
        }

        if (isRoomOwner) {

            if (loadSceneEnabled) {
                loadSavedScene();
            }
        }

        for (const socketId of users) {

            const remoteParticipantId =
                participantMap[socketId];

            if (!remoteParticipantId) {

                console.warn(
                    "Missing participantId for socket:",
                    socketId
                );

                continue;
            }

            await createPeer(
                socketId,
                true
            );
        }

        joinedRoom = true;

        document.getElementById(
            "scrollBox"
        ).style.display = "none";
    }
);


socket.on(
    "user-joined",
    async id => {
        // Existing users receive this.
        //
        // They do NOT load their local
        // scene here.
        //
        // Their current scene will be
        // sent through DataChannel.

        await createPeer(
            id,
            false
        );
    }
);


// ========================================
// WebRTC signaling
// ========================================

socket.on(
    "signal",
    async ({
        from,
        signal
    }) => {

        let pc =
            peers[from];

        if (!pc) {
            pc =
                await createPeer(
                    from,
                    false
                );
        }

        try {

            // ----------------------------
            // Track metadata
            // ----------------------------

            if (
                signal.type ===
                "track-info"
            ) {
                remoteTrackInfo[
                    from
                ] = {
                    colorTrackId:
                        signal.colorTrackId,

                    alphaTrackId:
                        signal.alphaTrackId
                };

                processPendingRemoteTracks(
                    from
                );

                return;
            }


            // ----------------------------
            // Offer
            // ----------------------------

            if (
                signal.type ===
                "offer"
            ) {

                await pc.setRemoteDescription(
                    new RTCSessionDescription(
                        signal
                    )
                );

                await flushIceCandidates(
                    from
                );

                const answer =
                    await pc.createAnswer();

                await pc.setLocalDescription(
                    answer
                );

                socket.emit(
                    "signal",
                    {
                        to: from,

                        signal:
                            pc.localDescription
                    }
                );

                return;
            }


            // ----------------------------
            // Answer
            // ----------------------------

            if (
                signal.type ===
                "answer"
            ) {

                await pc.setRemoteDescription(
                    new RTCSessionDescription(
                        signal
                    )
                );

                await flushIceCandidates(
                    from
                );

                return;
            }


            // ----------------------------
            // ICE
            // ----------------------------

            if (
                signal.candidate
            ) {

                if (
                    pc.remoteDescription &&
                    pc.remoteDescription.type
                ) {

                    await pc.addIceCandidate(
                        new RTCIceCandidate(
                            signal
                        )
                    );

                } else {

                    if (
                        !pendingIceCandidates[
                            from
                        ]
                    ) {
                        pendingIceCandidates[
                            from
                        ] = [];
                    }

                    pendingIceCandidates[
                        from
                    ].push(signal);
                }

                return;
            }

        } catch (err) {

            console.error(
                "WebRTC signaling error:",
                err
            );
        }
    }
);


// ========================================
// Flush ICE
// ========================================

async function flushIceCandidates(
    id
) {
    const pc =
        peers[id];

    if (!pc) {
        return;
    }

    const list =
        pendingIceCandidates[id];

    if (!list) {
        return;
    }

    delete pendingIceCandidates[
        id
    ];

    for (
        const candidate
        of list
    ) {
        try {

            await pc.addIceCandidate(
                new RTCIceCandidate(
                    candidate
                )
            );

        } catch (err) {

            console.error(
                "ICE candidate error:",
                err
            );
        }
    }
}


// ========================================
// DataChannel helpers
// ========================================

const DATA_CHUNK_SIZE =
    16000;


function sendData(
    id,
    data
) {
    const channel =
        dataChannels[id];

    if (
        !channel ||
        channel.readyState !==
            "open"
    ) {
        return false;
    }

    try {
        const json =
            JSON.stringify(data);

        // Small message
        if (
            json.length <=
            DATA_CHUNK_SIZE
        ) {
            channel.send(
                JSON.stringify({
                    type:
                        "message",
                    data
                })
            );

            return true;
        }

        // Large message
        const transferId =
            `${Date.now()}-${Math.random()}`;

        const total =
            Math.ceil(
                json.length /
                DATA_CHUNK_SIZE
            );

        channel.send(
            JSON.stringify({
                type:
                    "chunk-start",
                transferId,
                total
            })
        );

        for (
            let i = 0;
            i < total;
            i++
        ) {
            const chunk =
                json.slice(
                    i *
                        DATA_CHUNK_SIZE,
                    (i + 1) *
                        DATA_CHUNK_SIZE
                );

            channel.send(
                JSON.stringify({
                    type:
                        "chunk",
                    transferId,
                    index: i,
                    data: chunk
                })
            );
        }

        channel.send(
            JSON.stringify({
                type:
                    "chunk-end",
                transferId
            })
        );

        return true;

    } catch (err) {

        console.error(
            "DataChannel send error:",
            err
        );

        return false;
    }
}


const incomingTransfers = {};


function handleDataMessage(
    id,
    raw
) {
    let message;

    try {
        message =
            JSON.parse(raw);
    } catch (err) {
        console.error(
            "Invalid DataChannel message:",
            err
        );
        return;
    }


    // --------------------------------
    // Normal message
    // --------------------------------

    if (
        message.type ===
        "message"
    ) {
        handleSceneMessage(
            id,
            message.data
        );

        return;
    }


    // --------------------------------
    // Large transfer start
    // --------------------------------

    if (
        message.type ===
        "chunk-start"
    ) {
        incomingTransfers[
            message.transferId
        ] = {
            total:
                message.total,
            chunks: []
        };

        return;
    }


    // --------------------------------
    // Large transfer chunk
    // --------------------------------

    if (
        message.type ===
        "chunk"
    ) {
        const transfer =
            incomingTransfers[
                message.transferId
            ];

        if (!transfer) {
            return;
        }

        transfer.chunks[
            message.index
        ] = message.data;

        return;
    }


    // --------------------------------
    // Large transfer end
    // --------------------------------

    if (
        message.type ===
        "chunk-end"
    ) {

        const transfer =
            incomingTransfers[
                message.transferId
            ];

        if (!transfer) {
            return;
        }

        delete incomingTransfers[
            message.transferId
        ];

        try {

            const json =
                transfer.chunks.join(
                    ""
                );

            const data =
                JSON.parse(json);

            handleSceneMessage(
                id,
                data
            );

        } catch (err) {

            console.error(
                "DataChannel chunk decode error:",
                err
            );
        }
    }
}


// ========================================
// DataChannel scene messages
// ========================================

function handleSceneMessage(
    from,
    data
) {
    if (!data || !data.type) {
        return;
    }


    // ====================================
    // New user requests current scene
    // ====================================

    if (
        data.type ===
        "scene-request"
    ) {
        // Any existing peer can provide
        // its current scene.

        sendSceneSnapshot(from);

        return;
    }


    // ====================================
    // Full scene snapshot
    // ====================================

    if (
        data.type ===
        "scene-snapshot"
    ) {
        applySceneSnapshot(
            data
        );

        return;
    }


    // ====================================
    // New image
    // ====================================

    if (
        data.type ===
        "image-add"
    ) {
        addImage(
            data.image
        );

        saveLocalScene();

        return;
    }


    // ====================================
    // Delete image
    // ====================================

    if (
        data.type ===
        "image-delete"
    ) {
        deleteImageLocal(
            data.id
        );

        saveLocalScene();

        return;
    }


    // ====================================
    // Transform
    // ====================================

    if (
        data.type ===
        "transform"
    ) {
        if (
            !data.transform ||
            !data.transform.id
        ) {
            return;
        }

        transforms[
            data.transform.id
        ] = data.transform;

        applyEditedTransform(
            data.transform.id
        );

        saveLocalScene();

        return;
    }


    // ====================================
    // Background
    // ====================================

    if (
        data.type ===
        "background"
    ) {
        applyBackground(
            data.image
        );

        saveLocalScene();

        return;
    }
}


// ========================================
// Scene snapshot
// ========================================

function createSceneSnapshot() {
    const images = [];

    document
        .querySelectorAll(
            ".image-box"
        )
        .forEach(box => {

            const id =
                box.id.replace(
                    "box-",
                    ""
                );

            const img =
                box.querySelector(
                    "img"
                );

            if (!img) {
                return;
            }

            images.push({
                id,
                data: img.src
            });
        });


    return {
        type:
            "scene-snapshot",

        background:
            currentBackground ||
            "",

        images,

        transforms:
            JSON.parse(
                JSON.stringify(
                    transforms
                )
            )
    };
}


function sendSceneSnapshot(
    id
) {
    const snapshot =
        createSceneSnapshot();

    sendData(
        id,
        snapshot
    );
}


function applySceneSnapshot(
    snapshot
) {
    if (!snapshot) {
        return;
    }


    // --------------------------------
    // Background
    // --------------------------------

    if (
        snapshot.background
    ) {
        applyBackground(
            snapshot.background
        );
    }


    // --------------------------------
    // Transforms
    // --------------------------------

    if (
        snapshot.transforms
    ) {
        Object.assign(
            transforms,
            snapshot.transforms
        );
    }


    // --------------------------------
    // Images
    // --------------------------------

    if (
        Array.isArray(
            snapshot.images
        )
    ) {

        for (
            const image
            of snapshot.images
        ) {

            if (!image.data) {
                continue;
            }

            addImage({
                id:
                    image.id,

                data:
                    image.data,

                dropX:
                    transforms[
                        image.id
                    ]?.x ?? 100,

                dropY:
                    transforms[
                        image.id
                    ]?.y ?? 100
            });
        }
    }


    // --------------------------------
    // Apply transforms
    // --------------------------------

    for (
        const id
        of Object.keys(
            transforms
        )
    ) {
        applyEditedTransform(
            id
        );
    }


    saveLocalScene();
}


// ========================================
// Setup DataChannel
// ========================================

function setupDataChannel(
    id,
    channel,
    initiator
) {
    dataChannels[id] =
        channel;


    channel.binaryType =
        "arraybuffer";


    channel.onopen = () => {

        console.log(
            "DataChannel open:",
            id,
            "initiator:",
            initiator
        );

        /*
         * IMPORTANT:
         *
         * all-users:
         *     existing users -> new user
         *
         * Therefore:
         *
         * initiator === true
         *     = new user
         *
         * initiator === false
         *     = existing user
         *
         * New user requests the scene.
         * Existing user sends the scene.
         */

        if (initiator) {

            sendData(
                id,
                {
                    type:
                        "scene-request"
                }
            );

        } else {

            sendSceneSnapshot(
                id
            );
        }
    };


    channel.onmessage = event => {
        handleDataMessage(
            id,
            event.data
        );
    };


    channel.onclose = () => {

        console.log(
            "DataChannel closed:",
            id
        );

        delete dataChannels[
            id
        ];
    };


    channel.onerror = err => {
        console.error(
            "DataChannel error:",
            id,
            err
        );
    };
}


// ========================================
// WebRTC Peer
// ========================================

async function createPeer(
    id,
    initiator
) {
    if (peers[id]) {
        return peers[id];
    }

    const pc =
        new RTCPeerConnection(
            configuration
        );

    peers[id] =
        pc;


    // ====================================
    // DataChannel
    // ====================================

    if (initiator) {

        const channel =
            pc.createDataChannel(
                "scene"
            );

        setupDataChannel(
            id,
            channel,
            true
        );
    }


    pc.ondatachannel =
        event => {

            setupDataChannel(
                id,
                event.channel,
                false
            );
        };


    // ====================================
    // COLOR
    // ====================================

    pc.addTrack(
        localColorTrack,
        colorStream
    );


    // ====================================
    // ALPHA
    // ====================================

    pc.addTrack(
        localAlphaTrack,
        alphaStream
    );


    // ====================================
    // Configure senders
    // ====================================

    const senders =
        pc.getSenders();

    const colorSender =
        senders.find(
            sender =>
                sender.track ===
                localColorTrack
        );

    const alphaSender =
        senders.find(
            sender =>
                sender.track ===
                localAlphaTrack
        );

    await configureSender(
        colorSender,
        12000000
    );

    await configureSender(
        alphaSender,
        4000000
    );


    // ====================================
    // Track metadata
    // ====================================

    socket.emit(
        "signal",
        {
            to: id,

            signal: {
                type:
                    "track-info",

                colorTrackId:
                    localColorTrack.id,

                alphaTrackId:
                    localAlphaTrack.id
            }
        }
    );


    // ====================================
    // Receive tracks
    // ====================================

    pc.ontrack = e => {

        console.log(
            "REMOTE TRACK RECEIVED",
            id,
            e.track.kind,
            e.track.id,
            e.streams?.[0]?.id
        );

        if (
            !pendingRemoteTracks[id]
        ) {
            pendingRemoteTracks[id] =
                [];
        }

        if (
            !pendingRemoteTracks[id]
                .some(
                    track =>
                        track.id ===
                        e.track.id
                )
        ) {
            pendingRemoteTracks[id]
                .push(
                    e.track
                );
        }

        processPendingRemoteTracks(
            id
        );
    };


    // ====================================
    // ICE
    // ====================================

    pc.onicecandidate =
        e => {

            if (!e.candidate) {
                return;
            }

            socket.emit(
                "signal",
                {
                    to: id,

                    signal:
                        e.candidate
                }
            );
        };


    // ====================================
    // Connection state
    // ====================================

    pc.onconnectionstatechange =
        () => {

            console.log(
                "Peer",
                id,
                "state:",
                pc.connectionState
            );

            if (
                pc.connectionState ===
                    "failed" ||
                pc.connectionState ===
                    "closed"
            ) {
                delete dataChannels[
                    id
                ];
            }
        };


    // ====================================
    // Offer
    // ====================================

    if (initiator) {
        await createOffer(
            id
        );
    }

    return pc;
}


// ========================================
// Remote tracks
// ========================================

function processPendingRemoteTracks(
    id
) {
    const tracks =
        pendingRemoteTracks[id];

    if (
        !tracks ||
        tracks.length === 0
    ) {
        return;
    }

    const remoteParticipantId =
        participantMap[id];

    if (!remoteParticipantId) {
        console.warn(
            "No participantId for remote socket:",
            id
        );
        return;
    }

    let box =
        document.getElementById(
            `box-${remoteParticipantId}`
        );

    if (!box) {
        box =
            createRemoteVideoBox(
                remoteParticipantId
            );
    }

    const state =
        box._transparentState;

    if (!state) {
        return;
    }

    const info =
        remoteTrackInfo[id];

    let colorTrack = null;
    let alphaTrack = null;


    if (info) {

        for (
            const track
            of tracks
        ) {

            if (
                track.id ===
                info.colorTrackId
            ) {
                colorTrack =
                    track;
            }

            if (
                track.id ===
                info.alphaTrackId
            ) {
                alphaTrack =
                    track;
            }
        }
    }


    if (
        !colorTrack &&
        !alphaTrack
    ) {

        if (
            tracks.length >= 1
        ) {
            colorTrack =
                tracks[0];
        }

        if (
            tracks.length >= 2
        ) {
            alphaTrack =
                tracks[1];
        }
    }


    if (
        colorTrack &&
        alphaTrack &&
        colorTrack.id ===
            alphaTrack.id
    ) {
        alphaTrack =
            null;
    }


    if (
        colorTrack &&
        state.colorTrack !==
            colorTrack
    ) {

        state.colorTrack =
            colorTrack;

        state.colorVideo.srcObject =
            new MediaStream([
                colorTrack
            ]);

        state.colorVideo
            .play()
            .catch(
                () => {}
            );
    }


    if (
        alphaTrack &&
        state.alphaTrack !==
            alphaTrack
    ) {

        state.alphaTrack =
            alphaTrack;

        state.alphaVideo.srcObject =
            new MediaStream([
                alphaTrack
            ]);

        state.alphaVideo
            .play()
            .catch(
                () => {}
            );
    }
}


// ========================================
// Offer
// ========================================

async function createOffer(
    id
) {
    const pc =
        peers[id];

    if (!pc) {
        return;
    }

    try {

        const offer =
            await pc.createOffer();

        await pc.setLocalDescription(
            offer
        );

        socket.emit(
            "signal",
            {
                to: id,

                signal:
                    pc.localDescription
            }
        );

    } catch (err) {

        console.error(
            "Offer error:",
            err
        );
    }
}


// ========================================
// Local video
// ========================================

function createLocalVideo() {
    createLocalVideoBox(
        participantId
    );
}


function createLocalVideoBox(
    id
) {
    let box =
        document.getElementById(
            `box-${id}`
        );

    if (box) {
        return box;
    }

    box =
        document.createElement(
            "div"
        );

    box.className =
        "video-box";

    box.id =
        `box-${id}`;


    if (!transforms[id]) {

        transforms[id] = {
            id,

            locked:
                false,

            x:
                100,

            y:
                100,

            scale:
                1,

            rotation:
                0,

            z:
                highestZ() + 1
        };
    }


    const canvas =
        document.createElement(
            "canvas"
        );

    canvas.width =
        videoCanvas.width;

    canvas.height =
        videoCanvas.height;


    box.appendChild(
        canvas
    );

    scene.appendChild(
        box
    );

    localSceneCanvases.add(
        canvas
    );


    box._transparentState = {
        local:
            true,

        canvas
    };


    enableDrag(
        box,
        id,
        "video"
    );

    applyEditedTransform(
        id
    );

    return box;
}


// ========================================
// Remote transparent video
// ========================================

function createRemoteVideoBox(
    id
) {
    let box =
        document.getElementById(
            `box-${id}`
        );

    if (box) {
        return box;
    }

    box =
        document.createElement(
            "div"
        );

    box.className =
        "video-box";

    box.id =
        `box-${id}`;


    if (!transforms[id]) {

        transforms[id] = {
            id,

            locked:
                false,

            x:
                100,

            y:
                100,

            scale:
                1,

            rotation:
                0,

            z:
                highestZ() + 1
        };
    }


    const colorVideo =
        document.createElement(
            "video"
        );

    colorVideo.autoplay =
        true;

    colorVideo.playsInline =
        true;

    colorVideo.muted =
        true;

    colorVideo.style.display =
        "none";


    const alphaVideo =
        document.createElement(
            "video"
        );

    alphaVideo.autoplay =
        true;

    alphaVideo.playsInline =
        true;

    alphaVideo.muted =
        true;

    alphaVideo.style.display =
        "none";


    const canvas =
        document.createElement(
            "canvas"
        );


    const outputCtx =
        canvas.getContext(
            "2d",
            {
                alpha:
                    true,

                willReadFrequently:
                    true
            }
        );


    const maskCanvas =
        document.createElement(
            "canvas"
        );


    const maskCtx =
        maskCanvas.getContext(
            "2d",
            {
                alpha:
                    false,

                willReadFrequently:
                    true
            }
        );


    box.appendChild(
        colorVideo
    );

    box.appendChild(
        alphaVideo
    );

    box.appendChild(
        canvas
    );

    scene.appendChild(
        box
    );


    const state = {
        colorVideo,

        alphaVideo,

        canvas,

        maskCanvas,

        outputCtx,

        maskCtx,

        colorTrack:
            null,

        alphaTrack:
            null,

        rendering:
            true
    };


    box._transparentState =
        state;


    function resize() {

        const width =
            colorVideo.videoWidth ||
            alphaVideo.videoWidth;

        const height =
            colorVideo.videoHeight ||
            alphaVideo.videoHeight;

        if (
            !width ||
            !height
        ) {
            return;
        }

        if (
            canvas.width !==
                width ||
            canvas.height !==
                height
        ) {

            canvas.width =
                width;

            canvas.height =
                height;

            maskCanvas.width =
                width;

            maskCanvas.height =
                height;
        }
    }


    colorVideo.addEventListener(
        "loadedmetadata",
        resize
    );

    alphaVideo.addEventListener(
        "loadedmetadata",
        resize
    );


    function renderRemote() {

        if (!state.rendering) {
            return;
        }

        resize();

        const width =
            canvas.width;

        const height =
            canvas.height;


        if (
            width > 0 &&
            height > 0 &&
            colorVideo.readyState >=
                2 &&
            alphaVideo.readyState >=
                2
        ) {

            try {

                outputCtx.clearRect(
                    0,
                    0,
                    width,
                    height
                );

                outputCtx.drawImage(
                    colorVideo,
                    0,
                    0,
                    width,
                    height
                );


                maskCtx.drawImage(
                    alphaVideo,
                    0,
                    0,
                    width,
                    height
                );


                const output =
                    outputCtx.getImageData(
                        0,
                        0,
                        width,
                        height
                    );

                const mask =
                    maskCtx.getImageData(
                        0,
                        0,
                        width,
                        height
                    );


                const outputData =
                    output.data;

                const maskData =
                    mask.data;


                for (
                    let i = 0;
                    i <
                        outputData.length;
                    i += 4
                ) {

                    outputData[i + 3] =
                        maskData[i];
                }


                outputCtx.putImageData(
                    output,
                    0,
                    0
                );

            } catch (err) {

                console.error(
                    "Remote composite error:",
                    err
                );
            }
        }

        requestAnimationFrame(
            renderRemote
        );
    }


    requestAnimationFrame(
        renderRemote
    );


    enableDrag(
        box,
        id,
        "video"
    );

    applyEditedTransform(
        id
    );

    return box;
}


// ========================================
// Transform
// ========================================

function applyEditedTransform(
    id
) {
    const box =
        document.getElementById(
            `box-${id}`
        );

    if (!box) {
        return;
    }

    if (!transforms[id]) {

        transforms[id] = {
            id,

            locked:
                false,

            x:
                100,

            y:
                100,

            scale:
                1,

            rotation:
                0,

            z:
                1
        };
    }


    const t =
        transforms[id];


    box.style.left =
        t.x + "px";

    box.style.top =
        t.y + "px";

    box.style.zIndex =
        t.z;

    box.style.transform =
        `scale(${t.scale}) rotate(${t.rotation}deg)`;
}


function sendEditedTransform(
    id
) {

    const transform =
        transforms[id];

    if (!transform) {
        return;
    }


    // ====================================
    // ต้องใช้ participantId
    // ====================================

    const message = {
        type:
            "transform",

        transform: {
            ...transform,

            id
        }
    };


    // Local persistence
    saveLocalScene();


    // P2P scene sync
    for (
        const peerId
        of Object.keys(
            dataChannels
        )
    ) {

        sendData(
            peerId,
            message
        );
    }
}


function highestZ() {
    return Math.max(
        0,

        ...Object.values(
            transforms
        ).map(
            t =>
                t.z || 0
        )
    );
}


function lowestZ() {
    return Math.min(
        0,

        ...Object.values(
            transforms
        ).map(
            t =>
                t.z || 0
        )
    );
}


// ========================================
// Z ordering
// ========================================

function bringForward(
    id
) {
    const currentZ =
        transforms[id].z;

    let otherId =
        null;

    let nearestHigherZ =
        Infinity;


    for (
        const [k, t]
        of Object.entries(
            transforms
        )
    ) {

        if (k === id) {
            continue;
        }

        if (
            t.z >
                currentZ &&
            t.z <
                nearestHigherZ
        ) {

            nearestHigherZ =
                t.z;

            otherId =
                k;
        }
    }


    if (otherId == null) {
        return;
    }


    const tmp =
        transforms[id].z;

    transforms[id].z =
        transforms[otherId].z;

    transforms[otherId].z =
        tmp;


    applyEditedTransform(
        id
    );

    sendEditedTransform(
        id
    );


    applyEditedTransform(
        otherId
    );

    sendEditedTransform(
        otherId
    );
}


function sendBackward(
    id
) {
    const currentZ =
        transforms[id].z;

    let otherId =
        null;

    let nearestLowerZ =
        -Infinity;


    for (
        const [k, t]
        of Object.entries(
            transforms
        )
    ) {

        if (k === id) {
            continue;
        }

        if (
            t.z <
                currentZ &&
            t.z >
                nearestLowerZ
        ) {

            nearestLowerZ =
                t.z;

            otherId =
                k;
        }
    }


    if (otherId == null) {
        return;
    }


    const tmp =
        transforms[id].z;

    transforms[id].z =
        transforms[otherId].z;

    transforms[otherId].z =
        tmp;


    applyEditedTransform(
        id
    );

    sendEditedTransform(
        id
    );


    applyEditedTransform(
        otherId
    );

    sendEditedTransform(
        otherId
    );
}


// ========================================
// Drag
// ========================================

function enableDrag(
    box,
    id,
    type
) {
    let dragging =
        false;

    let offsetX =
        0;

    let offsetY =
        0;

    let alpha =
        255;


    const canvas =
        box.querySelector(
            "canvas"
        );


    box.addEventListener(
        "pointerdown",
        e => {

            const t =
                transforms[id];

            if (
                !t.locked &&
                alpha !== 0
            ) {

                dragging =
                    true;

                offsetX =
                    e.clientX -
                    transforms[id].x;

                offsetY =
                    e.clientY -
                    transforms[id].y;

                box.setPointerCapture(
                    e.pointerId
                );
            }
        }
    );


    box.addEventListener(
        "pointermove",
        e => {

            if (!dragging) {
                return;
            }

            const t =
                transforms[id];

            t.x =
                e.clientX -
                offsetX;

            t.y =
                e.clientY -
                offsetY;

            applyEditedTransform(
                id
            );

            sendEditedTransform(
                id
            );
        }
    );


    box.addEventListener(
        "pointerup",
        () => {
            dragging =
                false;
        }
    );


    box.addEventListener(
        "pointercancel",
        () => {
            dragging =
                false;
        }
    );


    box.addEventListener(
        "wheel",
        e => {

            e.preventDefault();

            const t =
                transforms[id];

            if (
                !t.locked &&
                alpha !== 0
            ) {

                if (e.altKey) {

                    t.rotation +=
                        e.deltaY > 0
                            ? 5
                            : -5;

                } else {

                    t.scale +=
                        e.deltaY > 0
                            ? -0.1
                            : 0.1;

                    t.scale =
                        Math.max(
                            0.2,
                            Math.min(
                                5,
                                t.scale
                            )
                        );
                }

                applyEditedTransform(
                    id
                );

                sendEditedTransform(
                    id
                );
            }
        },
        {
            passive:
                false
        }
    );


    box.addEventListener(
        "mousedown",
        e => {

            const t =
                transforms[id];


            if (
                e.button === 1
            ) {

                e.preventDefault();

                if (
                    !t.locked &&
                    alpha !== 0
                ) {

                    if (
                        e.altKey
                    ) {
                        sendBackward(
                            id
                        );
                    } else {
                        bringForward(
                            id
                        );
                    }
                }


            } else if (
                e.button === 2
            ) {

                e.preventDefault();


                if (
                    e.altKey
                ) {

                    if (
                        type ===
                        "image"
                    ) {

                        deleteImage(
                            id
                        );
                    }


                } else {

                    t.locked =
                        !t.locked;

                    applyEditedTransform(
                        id
                    );

                    sendEditedTransform(
                        id
                    );
                }
            }
        }
    );


    document.addEventListener(
        "auxclick",
        e => {
            e.preventDefault();
        }
    );


    document.addEventListener(
        "contextmenu",
        e => {
            e.preventDefault();
        }
    );


    document.addEventListener(
        "pointermove",
        e => {

            mouse.x =
                e.clientX;

            mouse.y =
                e.clientY;


            if (!canvas) {
                return;
            }


            const rect =
                canvas.getBoundingClientRect();


            if (
                rect.width === 0 ||
                rect.height === 0
            ) {
                return;
            }


            const x =
                Math.floor(
                    (
                        mouse.x -
                        rect.left
                    ) *
                    canvas.width /
                    rect.width
                );


            const y =
                Math.floor(
                    (
                        mouse.y -
                        rect.top
                    ) *
                    canvas.height /
                    rect.height
                );


            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y)
            ) {
                return;
            }


            const px =
                Math.max(
                    0,

                    Math.min(
                        canvas.width - 1,
                        x
                    )
                );


            const py =
                Math.max(
                    0,

                    Math.min(
                        canvas.height - 1,
                        y
                    )
                );


            if (
                type ===
                "video"
            ) {

                alpha =
                    0;

                try {

                    const pixel =
                        canvas
                            .getContext(
                                "2d"
                            )
                            .getImageData(
                                px,
                                py,
                                1,
                                1
                            )
                            .data;

                    alpha =
                        pixel[3];

                } catch {
                    alpha =
                        0;
                }


            } else if (
                type ===
                "image"
            ) {

                try {

                    const pixel =
                        canvas
                            .getContext(
                                "2d"
                            )
                            .getImageData(
                                px,
                                py,
                                1,
                                1
                            )
                            .data;

                    alpha =
                        pixel[3];

                } catch {
                    alpha =
                        0;
                }
            }


            if (
                alpha === 0
            ) {

                box.style.pointerEvents =
                    "none";

            } else {

                box.style.pointerEvents =
                    "auto";
            }
        }
    );
}


// ========================================
// Images
// ========================================

function addImage(
    image
) {
    let box =
        document.getElementById(
            `box-${image.id}`
        );

    if (box) {
        return box;
    }


    box =
        document.createElement(
            "div"
        );

    box.className =
        "image-box";

    box.id =
        `box-${image.id}`;


    if (
        !transforms[
            image.id
        ]
    ) {

        transforms[
            image.id
        ] = {

            id:
                image.id,

            locked:
                false,

            x:
                image.dropX ??
                100,

            y:
                image.dropY ??
                100,

            scale:
                1,

            rotation:
                0,

            z:
                highestZ() + 1
        };
    }


    const img =
        document.createElement(
            "img"
        );


    const canvas =
        document.createElement(
            "canvas"
        );


    img.src =
        image.data;


    const imageCtx =
        canvas.getContext(
            "2d"
        );


    img.onload = () => {

        canvas.width =
            img.width;

        canvas.height =
            img.height;

        imageCtx.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );

        imageCtx.drawImage(
            img,
            0,
            0
        );

        applyEditedTransform(
            image.id
        );
    };


    box.appendChild(
        img
    );

    box.appendChild(
        canvas
    );

    scene.appendChild(
        box
    );


    enableDrag(
        box,
        image.id,
        "image"
    );


    applyEditedTransform(
        image.id
    );


    return box;
}


// ========================================
// Delete image
// ========================================

function deleteImageLocal(
    id
) {
    const box =
        document.getElementById(
            `box-${id}`
        );

    if (box) {
        box.remove();
    }

    delete transforms[id];

    saveLocalScene();
}


function deleteImage(
    id
) {
    deleteImageLocal(
        id
    );

    for (
        const peerId
        of Object.keys(
            dataChannels
        )
    ) {

        sendData(
            peerId,
            {
                type:
                    "image-delete",

                id
            }
        );
    }
}


// ========================================
// Drop image
// ========================================

scene.addEventListener(
    "dragover",
    e => {
        e.preventDefault();
    }
);


scene.addEventListener(
    "drop",
    e => {

        e.preventDefault();

        const file =
            e.dataTransfer.files[0];

        if (!file) {
            return;
        }


        if (
            file.type !==
            "image/png"
        ) {
            alert(
                "PNG only"
            );

            return;
        }


        const reader =
            new FileReader();


        reader.onload =
            () => {

                const img =
                    new Image();


                img.onload =
                    () => {

                        const image = {

                            id:
                                `${socket.id}-${Date.now()}-${Math.random()}`,

                            data:
                                reader.result,

                            dropX:
                                mouse.x -
                                img.width /
                                    2,

                            dropY:
                                mouse.y -
                                img.height /
                                    2
                        };


                        addImage(
                            image
                        );


                        saveLocalScene();


                        for (
                            const peerId
                            of Object.keys(
                                dataChannels
                            )
                        ) {

                            sendData(
                                peerId,
                                {
                                    type:
                                        "image-add",

                                    image
                                }
                            );
                        }
                    };


                img.src =
                    reader.result;
            };


        reader.readAsDataURL(
            file
        );
    }
);


// ========================================
// Background
// ========================================

function applyBackground(image) {

    currentBackground = image || "";

    if (
        !image ||
        image === "data:image/png;base64,"
    ) {
        scene.style.backgroundImage = "";
        return;
    }

    scene.style.backgroundImage =
        `url(${image})`;

    scene.style.backgroundSize =
        "cover";

    scene.style.backgroundPosition =
        "center";
}


document.addEventListener(
    "keydown",
    async e => {

        if (
            e.ctrlKey &&
            e.key === "\\"
        ) {

            e.preventDefault();

            if (!localStream) {
                return;
            }


            // ล้าง Background เดิมก่อน
            applyBackground("");


            // บันทึกและ sync การล้าง Background
            saveLocalScene();


            for (
                const peerId
                of Object.keys(
                    dataChannels
                )
            ) {

                sendData(
                    peerId,
                    {
                        type:
                            "background",

                        image:
                            ""
                    }
                );
            }


            try {

                const [fileHandle] =
                    await window.showOpenFilePicker({

                        multiple: false,

                        types: [
                            {
                                description:
                                    "PNG Image",

                                accept: {
                                    "image/png":
                                        [".png"]
                                }
                            }
                        ]
                    });


                const file =
                    await fileHandle.getFile();


                const reader =
                    new FileReader();


                reader.onload =
                    () => {

                        const image =
                            reader.result;


                        applyBackground(
                            image
                        );


                        saveLocalScene();


                        for (
                            const peerId
                            of Object.keys(
                                dataChannels
                            )
                        ) {

                            sendData(
                                peerId,
                                {
                                    type:
                                        "background",

                                    image
                                }
                            );
                        }
                    };


                reader.readAsDataURL(
                    file
                );

            }
            catch (error) {

                // กดยกเลิก picker
                // Background จะยังคงถูกล้างแล้ว
                if (
                    error.name !==
                    "AbortError"
                ) {

                    console.error(
                        "Background picker error:",
                        error
                    );
                }
            }
        }
    }
);


// ========================================
// User left
// ========================================

socket.on(
    "user-left",
    id => {

        if (peers[id]) {

            peers[id].close();

            delete peers[id];
        }


        if (
            dataChannels[id]
        ) {

            try {
                dataChannels[
                    id
                ].close();
            } catch {}
        }


        const remoteParticipantId =
            participantMap[id];


        delete dataChannels[
            id
        ];

        delete remoteTrackInfo[
            id
        ];

        delete pendingRemoteTracks[
            id
        ];

        delete pendingIceCandidates[
            id
        ];


        delete participantMap[id];

        const box =
            document.getElementById(
                `box-${remoteParticipantId || id}`
            );


        if (box) {

            const state =
                box._transparentState;

            if (state) {
                state.rendering =
                    false;
            }

            box.remove();
        }
    }
);


// ========================================
// Room closed
// ========================================

socket.on(
    "room-closed",
    message => {

        alert(message);

        // No ownedURL anymore.
        //
        // Return to the current
        // application page.

        window.location.reload();
    }
);