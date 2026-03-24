import mongoose from "mongoose";

const ResultSchema = new mongoose.Schema(
  {
    smiles: { type: String, required: true },
    score: { type: Number, required: true },
    dockingData: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

const DiscoverySessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    targetProtein: {
      name: { type: String, required: true },
      uniprotId: { type: String, required: true },
      pdbUrl: { type: String, default: null },
      structureFileId: { type: String, default: null },
      pockets: { type: [mongoose.Schema.Types.Mixed], default: [] }
    },
    searchParameters: {
      librarySource: { type: String, default: "zinc22" },
      minAffinity: { type: Number, default: -7.0 }
    },
    results: { type: [ResultSchema], default: [] },
    status: {
      type: String,
      enum: ["pending", "folding", "screening", "completed"],
      default: "pending"
    },
    progress: {
      percent: { type: Number, default: 0 },
      message: { type: String, default: "Queued" }
    }
  },
  { timestamps: true }
);

export const DiscoverySession = mongoose.model("DiscoverySession", DiscoverySessionSchema);
