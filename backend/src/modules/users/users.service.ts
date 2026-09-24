import { AppError } from "../../middleware/errorHandler";
import type { UsersRepository } from "./users.repository";
import type { OwnProfile, ProfileUpdateInput, PublicProfile } from "./users.types";

export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async getOwnProfile(userId: string): Promise<OwnProfile> {
    const profile = await this.usersRepository.findOwnProfile(userId);
    if (!profile) {
      throw new AppError("User not found", 404);
    }
    return profile;
  }

  async getPublicProfile(userId: string): Promise<PublicProfile> {
    const profile = await this.usersRepository.findPublicProfile(userId);
    if (!profile) {
      throw new AppError("User not found", 404);
    }
    return profile;
  }

  async updateOwnProfile(userId: string, updates: ProfileUpdateInput): Promise<OwnProfile> {
    return this.usersRepository.updateProfile(userId, updates);
  }

  async search(query: string, requestingUserId: string): Promise<PublicProfile[]> {
    return this.usersRepository.search(query, requestingUserId);
  }
}
